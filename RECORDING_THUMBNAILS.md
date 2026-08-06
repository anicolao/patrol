# Recording thumbnail pipeline

## Goal

History scrubbing should display a camera frame immediately. The recording files are already split into approximately 15-second segments, so Patrol will precompute one small JPEG for every settled main-stream segment and use the JPEG for every preview within that segment.

The HTTP request path must not read video from the NVR or launch `ffmpeg`. A thumbnail request is a deterministic lookup in a local derived-data directory and either returns the JPEG or a fast 404 while a newly recorded segment is still being processed.

## Data flow

1. The recorder closes a segment, records it in SQLite, and appends `recording.segment.observed`.
2. The recording catalog's event sync provides recovery for catalog state.
3. A supervised `patrol-thumbnailer` worker selects active main-stream segments without a thumbnail, newest first.
4. The worker extracts a frame near the start of each segment, scales it to 180 pixels wide, and atomically renames the completed JPEG into the thumbnail cache.
5. The worker records success or a bounded retry in the catalog.
6. `/api/recordings/thumbnail?path=<segment>` maps the segment path to the local JPEG and serves it with immutable caching.

The browser deliberately sends no time offset. Every point within a segment has the same preview image. Video playback still seeks to the exact investigation time.

## Storage and naming

Generated thumbnails are derived data and do not belong on `/Volumes/NVR`. The default root is:

`~/.cache/patrol/recording-thumbnails`

`PATROL_THUMBNAIL_DIR` can override it. The web process and worker must run as the same data-owning account or receive the same override.

Paths are deterministic and sharded by the segment start time:

`<stream>/<YYYY>/<MM>/<DD>/<HH>/<segment-start-seconds>.jpg`

Only cataloged main-stream paths of the form `<stream>/<segment-start-ms>.mp4` are accepted. The worker writes a temporary file beside the destination and renames it only after `ffmpeg` succeeds, so readers never see partial images.

At seven cameras, one 15-second main-stream segment per camera produces about 40,000 thumbnails per day. At a few kilobytes per image, seven days is expected to occupy roughly 1–2 GB.

## Catalog state and retries

`recording_thumbnails` is keyed by recording relative path. It tracks the generated relative JPEG path and size, or the last failure, attempt count, and next retry time. Pending work is selected with an indexed query rather than by walking the recording or thumbnail directories.

Generation is intentionally low-concurrency to avoid competing with recording I/O. The worker processes newest segments first, which makes current investigations usable before historical backfill completes. Failed extraction is retried after a delay and does not block other cameras.

## Retention

The worker retains thumbnails for seven days by default (`PATROL_THUMBNAIL_RETENTION_MS`). It removes only exact files listed in catalog rows when their source segment is expired or outside thumbnail retention, then removes the corresponding catalog row. It never performs broad recursive deletion.

## Supervision and recovery

`patrol-thumbnailer` is installed as a user LaunchAgent alongside the other Patrol workers. It emits process heartbeats and is part of the expected system process list, so launchd restarts a crashed worker and the existing watchdog reports a missing or stale worker.

On reboot the GUI user's LaunchAgent starts the command, which connects to the `security` account in the current deployment. The worker resumes entirely from the recording catalog; no in-memory queue is required.

## Failure behavior

- A missing thumbnail returns 404 immediately. The UI shows its existing unavailable placeholder.
- The server never falls back to synchronous extraction.
- An unreadable source segment creates a retry record and leaves later work unblocked.
- Loss of the derived cache is recoverable: when the cache root is absent at worker startup, generated catalog entries are reset and rebuilt newest first.
- Loss of the SQLite thumbnail table is recoverable from the recording catalog and source segments.

## Deployment and verification

Deploy the web code and worker from one committed revision, install only the new `thumbnailer` LaunchAgent, and restart the web preview. Verify that the worker heartbeat is current, recent main segments acquire catalog rows and JPEGs, thumbnail HTTP requests avoid `ffmpeg` and complete as local file reads, and all expected Patrol processes remain healthy.
