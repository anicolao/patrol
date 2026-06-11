# Patrol Historical Recordings

Patrol records both go2rtc streams continuously:

- `main`: full-quality stream retained for 7 days.
- `sub`: low-bandwidth substream retained for 30 days.
- Annke camera-side AI alert events are replayed against retained segment events so the History tab can jump directly to the matching recording segment.

## Storage Estimate

The initial estimate uses conservative H.265 camera bitrates:

- Main stream: 8.5 Mbps
- Substream: 0.7 Mbps

Per camera:

- 7 days of main stream: about 642.6 GB
- 30 days of substream: about 226.8 GB
- Total steady-state retention: about 869.4 GB per camera

Formula:

```text
bytes = cameras * bits_per_second * retention_days * 24 * 60 * 60 / 8
```

Actual storage depends on the camera's bitrate settings, scene complexity, audio, and codec. Once `patrol-recorder` has observed segment files, the UI shows observed on-disk bytes in the History tab.

## Running

Start go2rtc first, then start the recorder from the Nix dev shell:

```sh
nix develop
patrol-go2rtc-start
patrol-recorder
```

The recorder reads camera configuration from append-only events and credentials from the secrets event log. It records from go2rtc's local RTSP fanout, not directly from the camera.

For Annke/Hikvision-compatible cameras, Patrol configures go2rtc with:

- Main stream: `/Streaming/Channels/101`
- Substream: `/Streaming/Channels/102`

Recorded files live under:

```text
.patrol/recordings/<stream-name>/<epoch-seconds>.mp4
```

Completed segment facts append to:

```text
.patrol/events/cameras-YYYY-MM-DD.jsonl
```

Retention is enforced by the recorder:

- Main stream segments older than 7 days are deleted and logged as expired.
- Substream segments older than 30 days are deleted and logged as expired.

Environment overrides:

```sh
PATROL_GO2RTC_RTSP_BASE_URL=rtsp://127.0.0.1:8554
PATROL_RECORDING_SEGMENT_SECONDS=15
PATROL_RECORDING_MIN_SEGMENT_BYTES=262144
PATROL_MAIN_RECORDING_RETENTION_DAYS=7
PATROL_SUB_RECORDING_RETENTION_DAYS=30
```
