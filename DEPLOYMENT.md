# Patrol Mac mini Deployment

This is the authoritative production deployment procedure for
`emryss-mac-mini`. Do not deploy source files with `scp` and do not edit
LaunchAgent plists by hand. A deployment is complete only when both Mac mini
checkouts are clean and point at the reviewed revision on `origin/main`.

## Production layout

| Purpose | Account | Path |
| --- | --- | --- |
| Runtime checkout | `security` | `/Users/security/projects/patrol` |
| LaunchAgent installer checkout | `emrys` | `/Users/emrys/projects/patrol-launchers` |
| Event logs, secrets, cache, and recognition data | `security` | `/Users/security/Library/PatrolData` |
| Video recordings | `security` | `/Volumes/NVR/recordings` |
| LaunchAgent definitions and logs | `emrys` | `/Users/emrys/Library/{LaunchAgents,Logs/Patrol}` |

`emrys` owns the GUI login session and its `gui/501` launchd domain. The
LaunchAgents use non-interactive SSH to run Patrol from the protected
`security` checkout. The separate public, read-only launcher checkout is
necessary because `/Users/security` is not readable by `emrys`.

Prerequisites:

- `emrys` can clone `https://github.com/anicolao/patrol.git` without credentials.
- `emrys` can run `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes security@localhost true`.
- The runtime checkout uses the public HTTPS remote
  `https://github.com/anicolao/patrol.git` so deployment does not depend on a
  GitHub SSH key for `security`.
- `/Volumes/NVR` is mounted and `/Volumes/NVR/recordings` is writable by `security`.
- The NVR APFS volume UUID is `995E4E1D-1663-45E2-82D7-FD40C8A360ED`.
- `/Users/security/Library/PatrolData/watchdog.env` exists and is readable only by `security`.

## Release through GitHub

From the development checkout:

1. Put all deployable changes on a branch. Do not include unrelated working-tree changes.
2. Run the same checks expected in deployment:

   ```sh
   npm run check
   npm run test:unit
   npm run build
   ```

3. Push the branch, open a pull request, and wait for required CI checks.
4. Merge the pull request into `main`.
5. Record the exact release revision:

   ```sh
   git fetch origin
   git rev-parse origin/main
   ```

Never deploy a revision that has not reached `origin/main`.

## Update the runtime checkout

Run from an operator workstation. A dirty runtime checkout is a stop condition;
inspect and preserve it before continuing.

```sh
ssh security@emryss-mac-mini '
  set -euo pipefail
  cd /Users/security/projects/patrol
  test -z "$(git status --porcelain)"
  git remote set-url origin https://github.com/anicolao/patrol.git
  git fetch origin --prune
  git switch main
  git merge --ff-only origin/main
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
'
```

Stop the persistent LaunchAgents before replacing dependencies and build
output. This creates a short maintenance window and avoids changing files
beneath running Node processes:

```sh
ssh emrys@emryss-mac-mini '
  set -euo pipefail
  for name in go2rtc events-ws web state-checkpoint annke-events person-recognizer thumbnailer recorder; do
    launchctl bootout "gui/501/com.patrol.$name" 2>/dev/null || true
  done
'

ssh security@emryss-mac-mini '
  set -euo pipefail
  cd /Users/security/projects/patrol
  nix develop --command npm ci
  nix develop --command npm run check
  nix develop --command npm run test:unit
  nix develop --command npm run build
'
```

### One-time recovery from a copied-file deployment

Older deployments copied individual files into the runtime checkout. Preserve
that state in a named stash before the first clean pull:

```sh
ssh security@emryss-mac-mini '
  set -euo pipefail
  cd /Users/security/projects/patrol
  git status --short
  git stash push --include-untracked -m "pre-clean-deployment-$(date -u +%Y%m%dT%H%M%SZ)"
  git fetch origin --prune
  git switch main
  git merge --ff-only origin/main
  test -z "$(git status --porcelain)"
'
```

Keep that stash until the clean deployment passes every verification step.
Do not apply it over the clean checkout.

## Update the LaunchAgent installer checkout

Create the installer checkout once, after the release is present on `main`:

```sh
ssh emrys@emryss-mac-mini '
  set -euo pipefail
  if ! test -d /Users/emrys/projects/patrol-launchers/.git; then
    git clone --branch main --single-branch \
      https://github.com/anicolao/patrol.git \
      /Users/emrys/projects/patrol-launchers
  fi
'
```

Update and verify it for every deployment:

```sh
ssh emrys@emryss-mac-mini '
  /bin/zsh -lc "
    set -euo pipefail
    cd /Users/emrys/projects/patrol-launchers
    test -z \"\$(git status --porcelain)\"
    git fetch origin --prune
    git switch main
    git merge --ff-only origin/main
    test \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse origin/main)\"
  "
'
```

## Install and restart services

Run the tracked installers from the `emrys` checkout. These commands regenerate
the complete plist arrays, bootstrap them in `gui/501`, and replace any ad-hoc
plist changes. Persistent jobs request an SSH pseudo-terminal so terminating a
LaunchAgent also sends a hangup to its process in the protected `security`
account; this prevents old processes from retaining service ports after a
restart.

Install the volume mount job first. It runs eagerly at login and once per
minute thereafter, doing nothing when NVR is already mounted:

```sh
ssh emrys@emryss-mac-mini '
  env \
    PATROL_RECORDING_VOLUME_UUID=995E4E1D-1663-45E2-82D7-FD40C8A360ED \
    /bin/zsh -lc "cd /Users/emrys/projects/patrol-launchers && \
      exec /run/current-system/sw/bin/nix develop --command patrol-recording-volume-launch-agent-install"
'
```

Install the shared services first:

```sh
ssh emrys@emryss-mac-mini '
  env \
    PATROL_SERVICES_REPO_ROOT=/Users/security/projects/patrol \
    PATROL_SERVICES_RUN_AS_USER=security \
    PATROL_DATA_DIR=/Users/security/Library/PatrolData \
    PATROL_RECORDINGS_DIR=/Volumes/NVR/recordings \
    PATROL_THUMBNAILER_WORK_DELAY_MS=8000 \
    PATROL_NIX_BIN=/run/current-system/sw/bin/nix \
    /bin/zsh -lc "cd /Users/emrys/projects/patrol-launchers && \
      exec /run/current-system/sw/bin/nix develop --command patrol-service-launch-agents-install"
'
```

Install the recorder with the approved retention policy:

```sh
ssh emrys@emryss-mac-mini '
  env \
    PATROL_RECORDER_REPO_ROOT=/Users/security/projects/patrol \
    PATROL_RECORDER_RUN_AS_USER=security \
    PATROL_DATA_DIR=/Users/security/Library/PatrolData \
    PATROL_RECORDINGS_DIR=/Volumes/NVR/recordings \
    PATROL_RECORDING_RETENTION_ENABLED=true \
    PATROL_RECORDING_RECOVERY_ENABLED=false \
    PATROL_RECORDING_SEGMENT_SECONDS=60 \
    PATROL_MAIN_RECORDING_RETENTION_DAYS=7 \
    PATROL_SUB_RECORDING_RETENTION_DAYS=30 \
    PATROL_RECORDING_STORAGE_LOW_WATERMARK_PERCENT=10 \
    PATROL_RECORDING_STORAGE_HIGH_WATERMARK_PERCENT=15 \
    PATROL_RECORDING_DELETE_CONCURRENCY=1 \
    PATROL_RECORDING_DELETE_DELAY_MS=3000 \
    PATROL_RECORDING_FS_THREADPOOL_SIZE=8 \
    PATROL_NIX_BIN=/run/current-system/sw/bin/nix \
    /bin/zsh -lc "cd /Users/emrys/projects/patrol-launchers && \
      exec /run/current-system/sw/bin/nix develop --command patrol-recorder-launch-agent-install"
'
```

Install the watchdog last:

```sh
ssh emrys@emryss-mac-mini '
  env \
    PATROL_WATCHDOG_REPO_ROOT=/Users/security/projects/patrol \
    PATROL_WATCHDOG_RUN_AS_USER=security \
    PATROL_DATA_DIR=/Users/security/Library/PatrolData \
    PATROL_WATCHDOG_ENV_FILE=/Users/security/Library/PatrolData/watchdog.env \
    PATROL_NIX_BIN=/run/current-system/sw/bin/nix \
    /bin/zsh -lc "cd /Users/emrys/projects/patrol-launchers && \
      exec /run/current-system/sw/bin/nix develop --command patrol-watchdog-launch-agent-install"
'
```

## Verify the deployment

Both checkouts must be clean and on the same release revision:

```sh
ssh security@emryss-mac-mini '
  cd /Users/security/projects/patrol
  git status --short --branch
  git rev-parse HEAD
  git rev-parse origin/main
'

ssh emrys@emryss-mac-mini '
  /bin/zsh -lc "
    cd /Users/emrys/projects/patrol-launchers
    git status --short --branch
    git rev-parse HEAD
    git rev-parse origin/main
  "
'
```

Wait at least 90 seconds for heartbeats and recording segments, then verify:

```sh
ssh security@emryss-mac-mini '
  set -euo pipefail
  health=$(curl -fsS -X POST http://127.0.0.1:5184/api/system/heartbeat)
  echo "$health" | jq -e ".errors | length == 0" >/dev/null
  echo "$health" | jq -e "[.processes[] | select(.health != \"ok\")] | length == 0" >/dev/null
  echo "$health" | jq -e "([.devices[].go2rtc.streams[]] | length) == ([.devices[].go2rtc.streams[] | select(.health == \"streaming\")] | length)" >/dev/null
  echo "$health" | jq -c "{processes: [.processes[] | .health] | group_by(.) | map({(.[0]): length}) | add, cameras: (.devices | length), errors: (.errors | length)}"
  echo "recorders=$(ps -axo command | grep \"ffmpeg -hide_banner -nostdin\" | grep -v grep | wc -l | tr -d \" \")"
  recent_streams=$(/usr/bin/sqlite3 \
    /Users/security/Library/PatrolData/cache/recording-catalog.sqlite \
    "SELECT count(*) FROM (SELECT stream_name FROM recording_segments GROUP BY stream_name HAVING max(observed_at_ms) >= (unixepoch('now') - 180) * 1000);")
  test "$recent_streams" -eq 14
  echo "recording_streams_advanced=$recent_streams/14"
  df -h /Volumes/NVR /System/Volumes/Data
'

ssh emrys@emryss-mac-mini '
  for name in recording-volume go2rtc events-ws web state-checkpoint annke-events person-recognizer thumbnailer recorder watchdog; do
    echo "=== $name"
    launchctl print gui/501/com.patrol.$name 2>/dev/null | \
      grep -E "state =|last exit code" | head -2
  done
'
```

The recording-volume and watchdog jobs are periodic jobs, so `state = not
running` with `last exit code = 0` is healthy. Persistent services must report
`state = running`.

On startup the recorder refuses to create or use a path below `/Volumes` unless
that volume is actually mounted. Launchd retries it after the NVR volume
appears; this prevents an unavailable external disk from redirecting recordings
onto the internal system disk.

## Rollback

If verification fails, keep the event and recording data in place. Select the
previous known-good Git revision in both checkouts, rebuild the runtime
checkout, and rerun all three installers. Use a named rollback branch rather
than rewriting `main`:

```sh
git switch -c rollback/<date>-<reason> <known-good-sha>
```

After recovery, fix forward through a reviewed pull request. Do not restore an
old SQLite catalog or event log over newer production data.
