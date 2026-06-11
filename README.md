# Patrol

[![E2E Tests](https://github.com/anicolao/patrol/actions/workflows/e2e.yml/badge.svg)](https://github.com/anicolao/patrol/actions/workflows/e2e.yml)

Patrol is a home security system for Annke cameras. It is designed to be
minimal, auditable, and integrated with the camera features that Annke exposes
through RTSP, ONVIF, and ISAPI.

The project starts from a few lessons learned while evaluating Frigate on macOS:

- `go2rtc` is a good stream fan-out layer.
- `ffmpeg` is a good local recorder when it can copy camera streams directly.
- The system needs stronger health checks than "the web UI still shows video."
- The event history should be the source of truth, not an opaque database.
- AI detections need enough image quality for downstream recognition tasks.

## Goals

- Record Annke camera streams reliably with minimal transcoding.
- Detect people, animals, cars, and license plates with local AI models.
- Use Annke-native APIs for camera metadata, audio, OSD, lights, alarms, and
  other capabilities when available.
- Store every system observation, user action, and configuration change as an
  append-only event.
- Rebuild current system state by replaying event logs through reducers.
- Provide a SvelteKit UI that displays live state and subscribes to event
  streams.
- Keep the first deployment small enough to understand, debug, and recover.

## Non-Goals

- Reimplement every feature in Frigate.
- Hide camera behavior behind a generic lowest-common-denominator abstraction.
- Depend on cloud services for core security functions.
- Treat the database as the primary truth before the append-only event log.
- Build a plugin system before the core camera pipeline is reliable.

## Architecture Sketch

```text
Annke cameras
  | RTSP / ONVIF / ISAPI
  v
go2rtc
  | local RTSP fan-out
  +--> ffmpeg recorder          -> video segments
  +--> AI frame extractors      -> detection events
  +--> live UI playback         -> browser stream

camera control workers          -> camera capability events
detectors                       -> object / face / plate events
recording indexer               -> recording lifecycle events
user interface                  -> user command events

append-only JSONL event logs
  |
  v
reducers
  |
  v
queryable state snapshots + SvelteKit UI
```

## Event Log

Subsystems append newline-delimited JSON events to durable files. Events are
Redux-style records: each event has a type, epoch timestamp, source, payload,
and stable identifiers for related cameras, streams, recordings, and
detections.

User actions are events too. If a person changes a setting, classifies a face,
plays an alarm sound, or marks a license plate as trusted, Patrol records that
command before applying it.

Camera configuration is also hydrated from events. Cameras should be added and
changed through the UI, with reducers materializing the effective camera state.
Secrets use a separate write-only event log and are materialized by a small
helper into the environment needed by stream workers such as go2rtc.

This gives the system one central debugging rule: if Patrol did something, there
should be an event explaining what it saw, decided, or was asked to do.

## Operations

Use `WATCHDOG_SETUP.md` to install the local cron watchdog. It checks the
system health reducer every minute and sends Pushover notifications when any
expected security service is not green.

Use `RECORDINGS_SETUP.md` for the historical recording worker. Patrol records
the main and sub streams continuously from go2rtc, keeps full-quality segments
for 7 days, keeps substream segments for 30 days, and exposes Annke alert
events in the History tab for direct playback.

## Repository Status

This repository now contains the early Patrol implementation: camera discovery,
go2rtc stream materialization, Annke event observation, live event streaming,
historical recording, and system health monitoring. `MVP_DESIGN.md` remains
the implementation guide for the next pieces of the pipeline.
