# Video History UX

This document proposes a richer History view for Patrol: a mobile-first vertical
video timeline that can jump to camera events, scrub through retained
recordings, and export clips from selected time ranges.

It is intentionally design-only. The goal is to settle the interaction model and
system shape before replacing the current single-segment video playback.

## Current State

The current History tab shows a list of camera-side events and, when an event is
selected, loads the single retained recording segment that overlaps that event.
Playback uses:

```text
/api/recordings/file?path=<segment>#t=<offset>
```

That is good enough for proving that events can link to recordings, but it has
important limits:

- The user sees events as a list, not as points in time.
- Seeking is constrained by the currently loaded MP4 segment.
- Moving across 15-second segment boundaries requires loading a different file.
- There is no in/out range selection.
- There is no user-facing clip export workflow.
- It does not visually explain recording retention gaps or main/substream
  quality fallback.

The richer UX should treat recordings as a continuous time surface, even though
the storage layer is still made of small segment files.

## Goals

- Make it fast to answer: "What happened around this time?"
- Make event review spatial: events should appear in a vertical time surface,
  not only as unrelated rows.
- Let the user seek to arbitrary points in retained video.
- Let the user select a time range and download a clip.
- Make mobile review comfortable without requiring a wide horizontal scrubber.
- Prefer full-quality main-stream video when retained, with visible substream
  fallback when main-stream video has expired.
- Preserve Patrol's event-sourced architecture: raw facts stay in event logs,
  reducers produce timeline state, and audit-worthy user actions are logged.
- Work well on mobile first, while allowing a denser desktop layout.

## Non-Goals

- Do not build a full video editor.
- Do not add multi-track editing, transitions, annotations, or destructive media
  edits.
- Do not require transcoding for normal playback if segment copy or HLS playlist
  playback is enough.
- Do not make timeline state depend on browser-only computation that cannot be
  reproduced by replaying events.

## User Workflows

### Review Recent Events

1. The user opens History.
2. The latest camera timeline is visible as a vertically scrollable feed.
3. Time and date labels run down the left rail.
4. Event thumbnails and event summaries appear on the right.
5. A fixed playhead sits in the center of the timeline viewport.
6. Scrolling the timeline under the fixed playhead scrubs the video.
7. Tapping an event row scrolls that row to the centered playhead and seeks the
   video to that event.
8. Person labels, vehicle labels, and motion labels appear on the event row and
   selected event panel when confidence is high enough.

### Scrub Around An Event

1. The user taps a person or vehicle event.
2. The timeline scrolls so the event time is centered under the fixed playhead.
3. Playback jumps to a configurable pre-roll, for example five seconds before
   the event, if the user entered through an "export around event" or review
   action. A plain tap should center the exact event time.
4. The user scrolls the timeline up or down to scrub the video. The playhead
   remains fixed.
5. The video updates continuously enough to understand motion, even if exact
   frame-accurate scrubbing is deferred.
6. Segment boundaries are invisible unless a recording gap exists.

### Scan Across Days

1. The user pinches inward on the vertical timeline.
2. The timeline compresses from minute-level detail to hour/day blocks.
3. Dense periods collapse into summarized rows, for example:

   ```text
   Person x3 (Pamela, Ethan)
   Vehicle x2
   Motion x9
   ```

4. The user scrolls quickly to another day or week.
5. The user pinches outward to expand back into fine-grained thumbnails and
   event rows.

### Inspect Dense Activity

1. Several events occur within a short time window.
2. The timeline coalesces them into one row instead of stacking tiny tap targets.
3. The row shows the best thumbnail and a compact summary.
4. Tapping the row expands it inline or opens a sheet with the individual
   events.
5. Choosing an individual event seeks the player to that event.

### Seek Without An Event

1. The user taps blank space in the right side of the vertical timeline.
2. Patrol maps that vertical position to an absolute timestamp.
3. The timeline scrolls so that timestamp lands under the fixed playhead.
4. Playback seeks to that timestamp.
5. If no retained recording exists at that time, the row shows a gap state
   instead of loading forever.

### Fine Scrub

1. The user pinches outward until the timeline is at minute-level detail.
2. Blank time between events expands enough to make arbitrary seek points
   tappable.
3. Thumbnail density increases where images exist.
4. Slow vertical scrolling becomes fine scrubbing because each pixel maps to a
   smaller amount of time.
5. The video updates continuously enough to understand motion, even if exact
   frame-accurate scrubbing is deferred.
6. Segment boundaries are invisible unless a recording gap exists.

### Export A Clip

1. The user enters selection mode.
2. The timeline shows two handles: start and end.
3. Handles snap to event time, segment boundaries, and current playhead.
4. The user previews the selected range.
5. The user chooses quality:
   - Best available
   - Full quality only
   - Substream
6. The user taps Download.
7. Patrol logs the export request, builds the clip server-side, logs completion
   or failure, and offers the resulting file.

### Investigate A Time Without An Event

1. The user opens the date/time picker or scrolls the compressed timeline.
2. The timeline viewport scrolls so the selected wall-clock time is centered
   under the fixed playhead.
3. The user can scroll and tap even if no event exists.
4. If no retained recording exists, the timeline clearly shows a gap instead of
   loading forever.

## Layout

The History view should be a first-class workspace. On mobile, the timeline and
event list should be the same component, and the playhead should stay fixed in
the visual center of that timeline component while the timeline scrolls beneath
it.

### Portrait Layout

```text
+------------------------------+
| Camera / date selector       |
+------------------------------+
| Video player                 |
|                              |
+------------------------------+
| Transport controls           |
+------------------------------+
| Vertical history timeline    |
|                              |
|  08:42 | [thumbnail] Person  |
|        | Alex 91%            |
|        |                     |
|  ----- fixed playhead ------ |
|        |                     |
|  08:30 |                     |
|        |                     |
|  08:18 | [thumbnail]         |
|        | Person x3           |
|        | Pamela, Ethan       |
|        |                     |
|  08:00 | -- recording gap -- |
|                              |
+------------------------------+
 bottom navigation remains fixed
```

Portrait places video at the top and the timeline below. The timeline viewport
scrolls under the existing bottom tab bar. The left rail is time; the right side
is both the event list and the seek surface. Blank time remains visible so the
user can understand quiet periods and tap into them.

The fixed playhead should remain visible in the center of the timeline. The
video player can collapse into a sticky mini-player while the user scrolls deep
into history, but timeline scrolling should still scrub the video.

### Landscape Layout

```text
+-------------------------------------------------------------+
| Camera / date selector / retention summary                  |
+-------------------------------+-----------------------------+
| Video player                  | Vertical history timeline    |
|                               |                             |
| Transport controls            | 08:42 | [thumbnail] Person  |
| Event detail / clip export    |       | Alex 91%            |
|                               | ----- fixed playhead ------ |
|                               | 08:30 |                     |
|                               | 08:18 | [thumbnail] x3      |
+-------------------------------+-----------------------------+
```

Landscape places video on the left and the vertical scrub timeline on the right.
This should apply to phones in landscape, tablets, and desktop-width browser
windows. The primary review surface remains vertical so the mobile and desktop
mental models match.

## Timeline Model

The timeline should show time, recording availability, events, thumbnails, and
selection as one vertically scrollable surface.

### Layers

- Time rail: wall-clock labels on the left, with date separators when crossing
  days.
- Availability rail: compact main/substream availability indicators beside the
  time rail.
- Event/content column: thumbnails, event summaries, and blank time.
- Gaps: explicit rows where Patrol expected recording but has no segment.
- Playhead: fixed horizontal line across the center of the timeline viewport.
- Selection range: vertical highlighted band with start/end handles for export.

The timeline maps scroll offset to absolute epoch milliseconds. The timestamp
under the fixed center playhead is the current playback time. At high zoom
levels, one screen may cover only a few minutes. At low zoom levels, one screen
may cover hours or days.

### Fixed Playhead

The playhead should behave like the stationary read head in an editor:

- It is visually fixed in the center of the timeline viewport.
- Scrolling the timeline changes `playheadMs` and scrubs the video.
- Tapping a row or blank region does not move the playhead. It scrolls the
  timeline so the tapped timestamp is centered under the playhead.
- Transport controls update `playheadMs` by scrolling the timeline, keeping the
  visual model consistent.
- Selection handles move relative to the fixed playhead; the playhead can be
  used as a precise "set start" or "set end" point.

### Vertical Density

The timeline should intentionally preserve empty time, but not waste unlimited
space. Density is a function of zoom:

- Expanded: blank time is visible and tappable at minute-level precision.
- Normal: quiet stretches are compressed but still represented with time labels.
- Compressed: quiet stretches become thin spacers; event clusters and day
  boundaries dominate.
- Overview: days or weeks fit on screen with summarized activity blocks.

The user should always be able to tell whether an empty region means "nothing
happened" or "recording is unavailable."

### Event Rows

Each event row should include:

- Best thumbnail.
- Event type and count.
- Recognized names when available.
- Camera name when multiple cameras exist.
- Recording quality badge.
- Timestamp or time range.

For a single recognized person:

```text
08:42 | [thumb] Person
      | Alex 91% - full quality
```

For coalesced activity:

```text
08:18 | [best thumb] Person x3
      | Pamela, Ethan - 24 sec
```

For mixed activity:

```text
17:31 | [best thumb] Person x2, Vehicle x1
      | driveway - 41 sec
```

The best thumbnail should be chosen by reducer-visible facts where possible:
known person confidence, object confidence, event severity, and frame quality
metadata if available. If no quality facts exist yet, use a deterministic
fallback such as earliest event thumbnail in the group.

### Zoom Levels

The same component should support several time scales:

- 5 minutes per screen: dense review, fine seek, precise clip selection.
- 30 minutes per screen: normal event browsing.
- 2 hours per screen: neighborhood activity scan.
- 24 hours per screen: day overview.
- 7 days per screen: retention and recurring activity overview.

Pinch, mouse wheel with modifier, and explicit zoom buttons should all update
the viewport. On mobile, pinch changes vertical time compression:

- Pinch out expands time, revealing more blank space and more individual
  thumbnails.
- Pinch in compresses time, coalescing dense event windows and making it faster
  to reach other days.
- The pinch focal point should remain anchored, so the time under the user's
  fingers stays stable while zoom changes.

### Coalescing Behavior

Events should coalesce when they would otherwise create crowded or repetitive
rows. Coalescing is viewport-dependent derived state, not a new event.

Coalescing inputs:

- Current zoom level.
- Event timestamps.
- Event type.
- Track or source event ID when available.
- Recognized person label and confidence.
- Camera ID.

Coalescing output:

- Time range.
- Count by type.
- Names seen in the group.
- Best thumbnail.
- List of underlying event IDs.

Example:

```json
{
  "startMs": 1781099196000,
  "endMs": 1781099220000,
  "summary": "Person x3",
  "names": ["Pamela", "Ethan"],
  "bestEventId": "01...",
  "eventIds": ["01...", "01...", "01..."]
}
```

Tapping a coalesced row should either expand it inline or open a bottom sheet of
the individual events. Pinching out should naturally split coalesced rows as the
time scale expands.

## Playback Behavior

The user should experience playback as continuous over a selected time window.
The implementation should not depend on loading one MP4 file per click.

Preferred playback source:

```text
GET /api/history/vod/<cameraId>/<role>/start/<startMs>/end/<endMs>/master.m3u8
```

The server can produce a short HLS playlist over existing segment files for the
current timeline window. This gives the browser one media source that spans
segment boundaries.

Fallback source:

```text
GET /api/recordings/file?path=<segment>
```

Fallback remains useful for debugging and as a phase-one implementation detail,
but the UX should be designed around continuous VOD playback.

### Seeking

Seeking should operate on absolute epoch milliseconds:

```text
playheadMs = 1781099196123
```

The UI maps timeline scroll offset to `playheadMs`, then maps `playheadMs` to a
VOD offset only at the player boundary. Reducers and timeline state should keep
absolute times so that event replay is stable and independent of segment layout.

Seeking gestures:

- Scroll: continuously updates `playheadMs`.
- Tap row: animates scroll so the row's timestamp reaches the fixed playhead.
- Tap blank space: maps the tapped point to a timestamp and centers it under the
  fixed playhead.
- Transport step: scrolls by a fixed time delta.
- Date picker: scrolls so the selected timestamp lands under the fixed
  playhead.

### Quality Selection

The default should be "Best available":

1. Use main stream if retained for the playhead time.
2. Fall back to substream if main stream has expired or is missing.
3. Show an explicit "substream" badge when fallback occurs.

The user can force main or substream. If forced main is unavailable, the player
should show a clear unavailable state instead of silently changing quality.

## Clip Selection

Clip selection is a mode on top of normal timeline browsing.

### Entering Selection

Entry points:

- Select range button in the transport controls.
- Long-press an event row, coalesced group, or blank timeline region.
- Select "Export around event" from an event detail panel.

Default range for event export:

```text
start = eventMs - 10000
end = eventMs + 20000
```

The user can drag either vertical handle or move the whole highlighted range.
On mobile, the selected range should be tall enough to manipulate without
covering the event text. When necessary, handles can appear in the left rail
while the selected range highlights the full row width.

### Selection Constraints

- Minimum duration: 2 seconds.
- Maximum duration: initially 10 minutes.
- Handles should snap to:
  - event time
  - current playhead
  - segment boundaries
  - round wall-clock increments such as 5 seconds and 30 seconds
- If the range crosses a recording gap, the UI should warn before export.

### Export Flow

Export should be a command with durable events:

```text
command.recording.export
recording.export.started
recording.export.completed
recording.export.failed
```

The request payload should include raw user intent:

```json
{
  "cameraId": "driveway",
  "startMs": 1781099186000,
  "endMs": 1781099216000,
  "quality": "best_available"
}
```

The completed event should record the produced file path, byte size, stream role
or roles used, and whether any gaps were present.

Normal export should use `ffmpeg -c copy` where possible. Transcoding should be
reserved for cases where stream copy cannot produce a playable clip.

## Event-Sourced State

The timeline is derived state. The underlying event logs should remain raw facts:

- `recording.segment.observed`
- `recording.segment.expired`
- camera-side alert events
- recognition events
- export command and export result events
- user audit events for committed interactions

Reducers should produce:

- retained segment ranges by camera and role
- recording gaps
- vertical timeline rows and coalesced groups for a requested time scale
- selected event if one has been committed
- recent clip export jobs

The UI may keep ephemeral pointer movement local while the user drags. Committed
actions should be logged, for example:

- opening an event detail
- committing a timeline seek from an event, blank region, or date picker
- submitting a clip export
- cancelling a clip export

Logging every pointer movement during a drag would create noisy logs without
improving auditability. The useful audit fact is the committed command and final
selected range.

## APIs Needed

### Timeline Query

```text
GET /api/history/timeline?cameraId=driveway&startMs=...&endMs=...
```

Returns reducer-derived timeline state for the requested vertical viewport and
zoom level:

```json
{
  "cameraId": "driveway",
  "startMs": 1781096400000,
  "endMs": 1781100000000,
  "zoom": "normal",
  "segments": [
    {
      "role": "main",
      "startMs": 1781099196000,
      "endMs": 1781099211000,
      "relativePath": "driveway_main/1781099196.mp4"
    }
  ],
  "gaps": [],
  "rows": [
    {
      "type": "event",
      "startMs": 1781099201234,
      "endMs": 1781099201234,
      "summary": "Person",
      "names": ["Alex"],
      "bestThumbnailEventId": "01...",
      "eventIds": ["01..."]
    },
    {
      "type": "group",
      "startMs": 1781099300000,
      "endMs": 1781099324000,
      "summary": "Person x3",
      "names": ["Pamela", "Ethan"],
      "bestThumbnailEventId": "01...",
      "eventIds": ["01...", "01...", "01..."]
    },
    {
      "type": "blank",
      "startMs": 1781099400000,
      "endMs": 1781099700000
    }
  ]
}
```

This is a view of reducer state, not a new source of truth.

### VOD Playlist

```text
GET /api/history/vod/<cameraId>/<role>/start/<startMs>/end/<endMs>/master.m3u8
```

Returns a playlist over retained MP4 segments for the current timeline window.
The initial implementation can use small windows, for example 10 to 30 minutes,
to keep playlists simple.

### Clip Export

```text
POST /api/history/clips
GET /api/history/clips/<clipId>
GET /api/history/clips/<clipId>/download
```

The POST appends the command event and starts or queues export work.

## Performance Requirements

- Loading History should not replay full event history in the browser.
- Timeline queries should be bounded by viewport time.
- The first useful paint should show the selected camera, latest retained range,
  and recent vertical timeline rows.
- Scrubbing should not trigger discovery requests or unrelated health polling.
- Timeline rows should be virtualized once the viewport spans many hours or
  days.
- Coalescing should happen before rendering so mobile DOM size remains small.
- Timeline rendering can start as normal DOM rows; use canvas only if row
  virtualization is not enough.

Target interaction budget:

- Tap event to visible first frame: under 300 ms when media is already warm.
- Tap event to visible first frame: under 1 second cold.
- Scroll or tap seek response: under 100 ms UI response, even if decoded video
  frame catches up more slowly.
- Export request acknowledgement: under 300 ms.

## Edge States

The timeline should explicitly represent these states:

- No cameras configured.
- Camera configured but no recording worker events.
- Recording worker alive but no retained segments.
- Segment gap at selected time.
- Main stream expired, substream available.
- Main stream available, substream missing.
- Export range crosses a gap.
- Export job failed.
- Selected event has no overlapping retained segment.

No state should look like an infinite spinner without an explanation.

## Accessibility

- Timeline controls need keyboard equivalents:
  - left/right: small seek
  - shift-left/shift-right: larger seek
  - space: play/pause
  - `i`: set in point
  - `o`: set out point
- Event rows, coalesced groups, blank seek regions, and selection handles need
  accessible names containing camera and time.
- Color coding cannot be the only signal; text labels and row shape are needed.
- Touch targets should be at least 44 by 44 CSS pixels.

## Implementation Phases

### Phase 1: Timeline Around Existing Playback

- Add a vertical timeline component using current reducer state.
- Show time rail, blank time, main/sub availability, event rows, and coalesced
  groups.
- Selecting a row scrolls it to the fixed center playhead and keeps using the
  current single-segment MP4 URL.
- Add fixed playhead display, scroll-to-scrub behavior, and selected event
  synchronization.
- Add pinch or explicit zoom controls for vertical compression.
- No export yet.

This phase validates the interaction model without changing media serving.

### Phase 2: Continuous VOD Playback

- Add timeline viewport API.
- Add VOD playlist endpoint over retained segments.
- Change the player to load a time-window playlist instead of one MP4 segment.
- Preserve absolute-time seeking in UI state.
- Add explicit recording gap display.
- Keep the vertical timeline as the main seek surface.

This phase fixes segment-boundary seeking.

### Phase 3: Clip Selection And Export

- Add selection mode with handles.
- Add export command events.
- Add server-side export worker.
- Add export job status and download link.
- Add tests for range selection, gap warning, and completed download.

### Phase 4: Timeline Polish

- Refine coalescing and expansion behavior.
- Add day/week overview navigation.
- Add thumbnail/keyframe previews if performance allows.
- Add keyboard shortcuts.
- Add richer event filters.

## Acceptance Criteria

- A user can open History and see recording availability before choosing an
  event.
- A user can tap a person, vehicle, motion row, or coalesced group and jump to
  matching video.
- A user can tap blank timeline space or scroll the timeline to arbitrary
  retained times without understanding segment files.
- A user can pinch in to scan across days and pinch out to inspect minute-level
  detail.
- Dense activity coalesces into readable rows with best thumbnails and names.
- A user can select a start and end time and download a playable clip.
- The UI clearly labels whether playback/export is full quality or substream.
- Timeline state is derived from event replay, not manually maintained side
  state.
- E2E tests cover at least:
  - event row selection
  - coalesced group expansion
  - blank-space seek
  - arbitrary seek
  - unavailable recording gap
  - clip range selection
  - export request event emission

## Open Questions

- Should clip export be synchronous for short clips, or always queued?
- What is the largest clip duration we want to allow from the UI?
- Should exports be retained in Patrol storage, or deleted after download?
- Do we want generated preview thumbnails beyond event thumbnails, and if so
  should they be generated by the recorder, an indexer, or lazily by the history
  API?
- How much user interaction should be logged for audit without making event logs
  noisy?
- Should History default to the latest event, latest recording time, or a blank
  "now" view?
