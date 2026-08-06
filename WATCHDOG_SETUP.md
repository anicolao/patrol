# Patrol Watchdog Setup

Patrol includes a cron watchdog that runs once per minute, checks the Health
page reducer state, and sends a Pushover notification when any expected
security service is not green.

The watchdog is event-sourced like the rest of Patrol:

- each run appends a `system.process.heartbeat` event for `patrol-watchdog`
- each check appends `system.watchdog.check_completed`
- each notification appends `system.watchdog.notification_sent`

The system health dashboard expects these tasks to stay green:

- `patrol-web`
- `patrol-events-ws`
- `patrol-go2rtc`
- `patrol-annke-events`
- `patrol-recorder`
- `patrol-state-checkpoint`
- `patrol-person-recognizer`
- `patrol-watchdog`

## Local Secrets

Create `.patrol/watchdog.env` locally. Do not commit it.

```sh
PATROL_PUSHOVER_TOKEN=your-pushover-application-token
PATROL_PUSHOVER_USER=your-pushover-user-key
PATROL_WATCHDOG_HEALTH_URL=http://127.0.0.1:5184/api/system/heartbeat
PATROL_WATCHDOG_NOTIFY_COOLDOWN_MS=900000
PATROL_PUSHOVER_SOUND=bugle
```

`PATROL_WATCHDOG_NOTIFY_COOLDOWN_MS` prevents repeated notifications for the
same failure. The default is 15 minutes.

## Install Cron

From the repository root:

```sh
nix develop --command patrol-watchdog-cron-install
```

The installer writes one crontab line marked `# patrol-watchdog`, preserving
other cron jobs and replacing any previous Patrol watchdog entry.

On macOS, if `crontab` is blocked by system permissions, the installer falls
back to a per-user LaunchAgent at
`~/Library/LaunchAgents/com.patrol.watchdog.plist`. The LaunchAgent uses the
same one-minute interval and the same `patrol-watchdog` command.

If both `crontab` and launchd are unavailable for the current account, the
installer starts a detached one-minute watchdog loop and records its PID in
`.patrol/watchdog-loop.pid`. This is useful for an SSH-only test deployment,
but a production deployment should eventually use a root-installed LaunchDaemon
so the watchdog survives reboot.

The cron job runs:

```sh
nix develop --command patrol-watchdog
```

Logs are appended to `.patrol/logs/watchdog.log`.

## Install A macOS User LaunchAgent

For a Mac that automatically logs in a desktop user, install the watchdog in
that user's GUI launchd domain:

```sh
PATROL_WATCHDOG_REPO_ROOT=/Users/security/projects/patrol \
PATROL_DATA_DIR=/Volumes/NVR/patrol \
PATROL_WATCHDOG_ENV_FILE=/Volumes/NVR/patrol/watchdog.env \
PATROL_WATCHDOG_RUN_AS_USER=security \
nix develop --command patrol-watchdog-launch-agent-install
```

Run the installer from a checkout accessible to the auto-login user. When
`PATROL_WATCHDOG_RUN_AS_USER` names a different account, the LaunchAgent uses
non-interactive SSH to that account on `localhost`; verify that key-based SSH
and strict host-key checking work before installing. This keeps protected
Patrol data access under the service account while launchd ownership remains
with the auto-login account.

The installer fails if the GUI launchd domain, environment file access, agent
bootstrap, kickstart, or post-install verification fails. It does not fall back
to a detached process that would disappear on reboot. LaunchAgent output is
written to `~/Library/Logs/Patrol/watchdog.log` for the auto-login user.

## Manual Test

Run a non-notifying check:

```sh
PATROL_WATCHDOG_DRY_RUN=1 nix develop --command patrol-watchdog
```

The command exits `0` when every expected service is green. It exits non-zero
and prints a failure summary when any expected service is stale, missing, or in
error.
