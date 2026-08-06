# Patrol Background Services

The macOS deployment runs these persistent Patrol processes as independent
user LaunchAgents:

- `patrol-events-ws`
- `patrol-annke-events`
- `patrol-state-checkpoint`
- `patrol-person-recognizer`
- `patrol-thumbnailer`

For a Mac that automatically logs in a desktop user, install the agents in
that user's GUI launchd domain:

```sh
PATROL_SERVICES_REPO_ROOT=/Users/security/projects/patrol \
PATROL_DATA_DIR=/Volumes/NVR/patrol \
PATROL_RECORDINGS_DIR=/Volumes/NVR/recordings \
PATROL_SERVICES_RUN_AS_USER=security \
nix develop --command patrol-service-launch-agents-install
```

Run the installer from a checkout accessible to the auto-login user. When
`PATROL_SERVICES_RUN_AS_USER` names a different account, each LaunchAgent uses
non-interactive SSH to that account on `localhost`. Each agent has `RunAtLoad`
and `KeepAlive` enabled, restarts independently, and writes output under
`~/Library/Logs/Patrol/` for the auto-login user.

To install or reinstall only selected agents, pass a comma-separated subset:

```sh
PATROL_LAUNCH_AGENT_SERVICES=events-ws,state-checkpoint \
nix develop --command patrol-service-launch-agents-install
```

Valid service identifiers are `events-ws`, `annke-events`,
`state-checkpoint`, `person-recognizer`, and `thumbnailer`.

The thumbnailer stores derived JPEGs under
`~/.cache/patrol/recording-thumbnails` for the account running the service.
Set `PATROL_THUMBNAIL_DIR` to give both the worker and web process another
local cache path. See [RECORDING_THUMBNAILS.md](RECORDING_THUMBNAILS.md) for
the pipeline and retention design.

The event WebSocket keeps a bounded recent catch-up index instead of loading
the complete event history into memory. It retains at most 10,000 events and
seeds that index from up to 8 MiB of each active event stream on startup. The
limits can be changed with `PATROL_EVENTS_WS_MAX_CATCH_UP_EVENTS` and
`PATROL_EVENTS_WS_INITIAL_INDEX_BYTES`.
