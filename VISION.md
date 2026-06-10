# Vision

Patrol should be boring in the places where security software must be boring:
recording, restart behavior, timekeeping, auditability, and camera recovery.
It should be ambitious only where the ambition pays for itself: local AI,
camera-specific integration, and a UI that makes the system understandable.

## Product Direction

The target deployment is a Mac mini or similar always-on machine on the home
network. Cameras live on a controlled network segment. Patrol receives camera
streams, records video locally, runs AI inference locally, exposes a private web
UI, and can be reached remotely through a secure network path such as Tailscale
or WireGuard.

The system should feel closer to a small, inspectable appliance than a large
platform. A person maintaining it should be able to answer:

- Is every camera reachable?
- Are recordings current?
- Is detection current?
- Which model or subsystem emitted this event?
- What did the system know when it made this decision?
- Which user changed this setting?
- Can the current UI state be rebuilt from durable logs?

## Design Principles

### Event Sourcing First

Every meaningful observation, command, and decision is appended to an event log.
The current state is a derived cache. If the derived state is wrong or corrupt,
the system should be able to replay events and recover.

Events should be simple JSON objects with explicit schemas. They should be easy
to inspect with command-line tools, archive, diff, and replay in tests.

### Camera-Native Integration

Annke cameras expose useful capabilities through open or documented interfaces:
RTSP for media, ONVIF for discovery and profiles, and Hikvision-compatible ISAPI
for many device controls. Patrol should use those APIs directly where they are
better than generic abstractions.

Examples:

- discover stream profiles and dimensions
- configure or read OSD state
- control audio output volume and test sounds
- detect supported light, alarm, or deterrence features
- retrieve camera-side motion or smart-event state where useful

### Minimal Stream Processing

The preferred media path is copy, index, and analyze:

- `go2rtc` owns camera connections and fans streams out locally.
- `ffmpeg` records the primary stream without transcoding when possible.
- AI workers consume explicit frame extraction streams sized for their task.
- The live UI uses the best available stream without stealing camera sessions.

Patrol should avoid accidental CPU-heavy decode paths. If decoding is required,
it should be visible in health metrics and logs.

### Detection Quality Over Checkbox Features

Object detection, face recognition, animal detection, vehicle detection, and
license plate reading have different image requirements. Patrol should not force
all AI tasks through one low-resolution detect stream.

The system should allow task-specific crops or frame sources:

- low-resolution stream for cheap motion/object triage
- high-resolution key frames or crops for faces and license plates
- full-resolution recording stream for evidence and playback

### Private by Default

The initial deployment should assume private access through a VPN or overlay
network rather than direct internet exposure. HTTPS, authentication, and reverse
proxy support are useful, but they should not mask an unhealthy backend or turn
the security system into a broad attack surface.

### Stability Is a Feature

Health checks are part of the product, not operational afterthoughts. A healthy
Patrol deployment must prove that:

- go2rtc producers are connected
- recording segments are advancing
- event logs are advancing
- detector workers are alive and emitting heartbeat events
- UI state reflects recent events
- camera outages and recoveries are recorded

## Relationship To Frigate

Frigate validates several architectural choices: local processing, go2rtc stream
fan-out, FFmpeg recording, and a web UI organized around cameras, events, and
recordings. Patrol may reuse compatible open-source ideas or dependencies, but
it should not inherit hidden state, unclear recovery behavior, or detection
quality compromises.

The first Patrol milestone is not "Frigate but rewritten." It is a smaller,
auditable Annke-focused system that records reliably, detects clearly, and makes
every decision inspectable.
