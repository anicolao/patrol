# MVP Design

The MVP is a single-machine Annke camera security system with durable recording,
event-sourced state, local detection, and a SvelteKit UI. It should support one
driveway camera first, while keeping camera identity and event schemas ready for
additional cameras.

## MVP Scope

### Included

- One or more Annke cameras configured by explicit camera IDs.
- `go2rtc` as the only process that connects directly to camera RTSP streams.
- `ffmpeg` recording of the primary stream into local segment files.
- A recording indexer that emits events as segments are created and finalized.
- Append-only JSONL event logs.
- Reducers that replay event logs into current system state.
- Camera configuration hydrated from configuration events submitted through the
  UI.
- A restricted write-only secrets event log plus a materializer for worker
  environment variables.
- A SvelteKit UI that subscribes to live events and displays derived state.
- Object detection for people, animals, and cars.
- License plate detection and OCR as a first-class planned detector path.
- Camera capability discovery through ONVIF/ISAPI.
- Health checks that detect stale streams, stale recordings, and silent workers.

### Deferred

- Multi-user permission model.
- Cloud notifications.
- Mobile app packaging.
- External automation integrations.
- Complex retention policies.
- NVR migration tooling.
- Public internet exposure.

## Process Model

The MVP should be a small set of long-running workers:

```text
patrol-go2rtc
  Owns camera RTSP connections and exposes local stream endpoints.

patrol-recorder
  Starts ffmpeg segment recorders from go2rtc streams.

patrol-indexer
  Watches segment output, validates files, and appends recording events.

patrol-detector
  Reads frames or crops, runs local AI models, and appends detection events.

patrol-camera-control
  Talks to Annke ONVIF/ISAPI APIs and appends capability/control events.

patrol-reducer
  Replays JSONL logs and writes compact derived state snapshots.

patrol-web
  Runs the SvelteKit UI and event subscription endpoint.

patrol-watchdog
  Checks semantic health and emits/restarts on failure.
```

Workers may begin as commands in one repository. The boundary that matters first
is the event log contract, not the number of binaries.

## Event Store

Events are newline-delimited JSON files under a durable data directory:

```text
data/
  events/
    system-2026-06-10.jsonl
    cameras-2026-06-10.jsonl
    recordings-2026-06-10.jsonl
    detections-2026-06-10.jsonl
    commands-2026-06-10.jsonl
  secrets/
    secrets-2026-06-10.jsonl
  state/
    current.json
    cameras.json
    recordings.json
```

Daily log files keep append operations simple and make archival predictable.
Every event should be immutable once written.

## Event Shape

Initial event shape:

```json
{
  "id": "01JZ3HZQ8F6Y7WQ9W4ZW2PSZVB",
  "ts_ms": 1781099112345,
  "type": "recording.segment.finalized",
  "source": "patrol-recorder",
  "schema": 1,
  "camera_id": "driveway",
  "correlation_id": "01JZ3HZPZ4ZK2WTKGG0E6F1S9B",
  "payload": {
    "path": "recordings/driveway/2026/06/10/13/45/10.mp4",
    "start_ts_ms": 1781099110000,
    "end_ts_ms": 1781099120000,
    "video_codec": "h264",
    "audio_codec": "pcmu",
    "width": 3632,
    "height": 1632,
    "bytes": 7218842
  }
}
```

Required top-level fields:

- `id`: globally unique event ID
- `ts_ms`: event timestamp as milliseconds since the Unix epoch in UTC
- `type`: reducer action type
- `source`: subsystem that appended the event
- `schema`: integer schema version
- `payload`: type-specific payload object

Events that relate to a camera should include `camera_id`. Events that are part
of a workflow should include `correlation_id`.

## Initial Event Types

System:

- `system.started`
- `system.stopped`
- `system.health.ok`
- `system.health.failed`
- `worker.heartbeat`
- `worker.restart.requested`
- `worker.restart.completed`

Camera:

- `camera.config.requested`
- `camera.config.applied`
- `camera.config.failed`
- `camera.discovered`
- `camera.capabilities.updated`
- `camera.stream.connected`
- `camera.stream.disconnected`
- `camera.stream.stats.updated`
- `camera.control.requested`
- `camera.control.completed`
- `camera.control.failed`

Recording:

- `recording.segment.started`
- `recording.segment.finalized`
- `recording.segment.failed`
- `recording.gap.detected`
- `recording.retention.applied`

Detection:

- `detection.frame.sampled`
- `detection.object.detected`
- `detection.face.detected`
- `detection.face.recognized`
- `detection.plate.detected`
- `detection.plate.read`
- `detection.track.started`
- `detection.track.updated`
- `detection.track.ended`

User commands:

- `command.user.login`
- `command.camera.add`
- `command.camera.update`
- `command.camera.remove`
- `command.camera.set_osd`
- `command.camera.play_sound`
- `command.camera.set_audio_volume`
- `command.detection.label_object`
- `command.face.register`
- `command.plate.mark_trusted`
- `command.recording.export`

Secrets:

- `secret.set.requested`
- `secret.set.applied`
- `secret.materialized`
- `secret.materialization.failed`

## Camera Configuration

Camera configuration should be explicit, but not checked into a local config
file. The UI should submit camera configuration commands, those commands should
be appended as events, and reducers should materialize the effective camera
state consumed by workers.

Example materialized camera state:

```yaml
cameras:
  driveway:
    vendor: annke
    host: 10.20.240.193
    rtsp:
      main: /Streaming/Channels/101?transportmode=unicast&profile=Profile_1
      sub: /Streaming/Channels/102?transportmode=unicast&profile=Profile_2
    roles:
      record: main
      live: main
      detect: sub
      recognize: main
    features:
      audio: true
      osd: true
      alarm_audio: true
      lights: discover
```

Secrets are configured through the UI as well, but they follow a separate path.
Secret values should be written only to a restricted append-only secrets event
log. The normal configuration event can record metadata such as secret ID,
camera ID, version, and update time, but not the secret value.

A small materializer script or binary should replay the secrets log and export
the runtime state needed by workers. For go2rtc, that can be environment
variables or generated local secret files that are readable only by the service
account. This keeps normal event replay auditable without spreading credentials
through general logs and state snapshots.

Example non-secret configuration event:

```json
{
  "id": "01JZ3J9JWR5ZYCKAZ3X24W2JKB",
  "ts_ms": 1781099200000,
  "type": "camera.config.applied",
  "source": "patrol-reducer",
  "schema": 1,
  "camera_id": "driveway",
  "payload": {
    "host": "10.20.240.193",
    "vendor": "annke",
    "rtsp_username_secret_id": "driveway.rtsp.username",
    "rtsp_password_secret_id": "driveway.rtsp.password",
    "main_stream": "/Streaming/Channels/101?transportmode=unicast&profile=Profile_1",
    "sub_stream": "/Streaming/Channels/102?transportmode=unicast&profile=Profile_2"
  }
}
```

## Media Pipeline

For each camera:

1. go2rtc connects to the camera main and substream.
2. recorder starts `ffmpeg` against the local go2rtc main stream.
3. recorder writes 10-second MP4 segments using stream copy where possible.
4. indexer validates completed files and appends recording events.
5. detector samples low-resolution frames for broad object detection.
6. detector requests high-resolution crops or frames for faces and plates.
7. web UI plays live streams through go2rtc and shows recording state from
   reducers.

The recorder should never depend on object detection being healthy. Detection
failure should create detection health events, not stop recording.

## AI Pipeline

The MVP should separate detection tasks by image requirement:

- Person, animal, and car detection can begin on the substream.
- Face recognition needs larger face crops from the main stream or recording
  segments.
- License plate reading needs high-resolution vehicle crops from the main stream
  or recording segments.

The first implementation can use separate workers and simple queues:

```text
object detector -> person/animal/car events
vehicle cropper -> plate detector -> OCR -> plate events
person cropper  -> face detector -> recognizer -> face events
```

Every AI output should include:

- model name and version
- input image source
- bounding box
- confidence
- track ID when available
- image or crop artifact path when retained

## Reducers And State

Reducers consume events and produce current state snapshots. The UI should read
snapshots for initial load and subscribe to new events for live updates.

Initial state domains:

- cameras and stream health
- current recording status
- recent detections
- active object tracks
- known faces
- known license plates
- camera capabilities
- worker health

Reducers must be deterministic. Given the same event files, they should produce
the same state.

Secret materialization is intentionally separate from normal reducers. Normal
reducers can track secret references and versions, but only the restricted
secret materializer should replay secret values.

## SvelteKit UI

The UI should be operational, not decorative.

Initial screens:

- Overview: camera health, recording health, detector health, recent events.
- Live: main stream playback and current detections.
- Events: timeline of people, animals, vehicles, faces, plates, and commands.
- Recordings: time-based video browser.
- Cameras: Annke capabilities, stream profiles, OSD, audio, alarms, lights.
- Camera Setup: add cameras, update stream roles, and submit credentials through
  the restricted secrets path.
- Audit: raw event log viewer with filters.

The UI should not mutate state directly. It should submit commands, log command
events, and then update when reducers process resulting events.

## Health Checks

The watchdog should check semantic health:

- go2rtc has a producer for every configured stream.
- recorder has finalized a recent segment for every camera.
- event logs are writable.
- reducer is caught up to the end of the logs.
- detector has emitted recent heartbeat events.
- camera clock and server clock are within expected tolerance if available.

Recovery should be evented:

1. append `system.health.failed`
2. append `worker.restart.requested`
3. restart the smallest affected worker
4. append `worker.restart.completed` or `system.health.failed`

Manual recovery actions from the UI should follow the same event path.

## Implementation Language

Patrol should be TypeScript-first:

- SvelteKit UI in TypeScript.
- API, reducers, event readers/writers, camera control workers, configuration
  materializers, and watchdogs in TypeScript unless profiling proves otherwise.
- Shared event schemas defined as TypeScript types and runtime validators.
- Performance-sensitive workers may be written in Go when measurement justifies
  the extra language boundary.

The current expectation is that the MVP can be implemented entirely in
TypeScript, because the expensive work is delegated to go2rtc, ffmpeg, and AI
runtime libraries.

## MVP Milestones

1. Repository scaffolding and event schema tests.
2. TypeScript event writer, reader, and reducer harness.
3. UI-driven camera configuration events and materialized camera state.
4. Restricted secrets event log and go2rtc environment materializer.
5. go2rtc config generation for one Annke camera.
6. FFmpeg recorder with segment finalization events.
7. Reducer that builds camera and recording state from JSONL.
8. SvelteKit overview showing live event-derived health.
9. Object detector emitting person/animal/car events.
10. High-resolution crop path for face and plate tasks.
11. License plate detection/OCR prototype.
12. Camera control worker for OSD, audio volume, and sound playback.
13. Watchdog restart loop with evented health failures.

## Open Questions

- Which hot paths, if any, justify Go instead of TypeScript?
- Which local models give the best license plate results on Apple Silicon?
- Should media metadata live only in events, or also in a small SQLite index
  derived from events?
- How much Annke/Hikvision ISAPI surface should be wrapped in the MVP?
- What is the best crop retention policy for face and plate recognition without
  producing excessive sensitive artifacts?
- What exact file permissions and process boundary should protect the secrets
  event log on macOS?
