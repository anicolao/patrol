# Client State Cache Design

## Status

Draft for review. This document describes the intended cache architecture before
implementation.

## Problem

Patrol is event sourced, but the UI must not feel like it is replaying the whole
security system every time a page is opened or an event arrives.

The current implementation has an important start:

- The server can materialize a `CameraStateSnapshot` in
  `.patrol/cache/camera-state.json`.
- The client stores a `CameraStateSnapshot` under
  `patrol.camera_state.v2` in `localStorage`.
- The websocket accepts `after_ts_ms` and `after_id` so a client can request
  event catch-up after its last cursor.

That is directionally correct, but it has performance and correctness limits:

- `localStorage` is synchronous. Writing the full state after every event can
  block the browser main thread, especially once recordings, history rows,
  person labels, crops, and health state grow.
- The cached state is one large object. A tiny heartbeat event causes the
  browser to serialize cameras, recordings, people, system health, and UI data.
- The websocket catch-up path scans all matching `.jsonl` files to find events
  after the cursor. That gets slower as the event log grows.
- The client has no explicit schema/projection version beyond the storage key,
  so reducer changes require blunt cache invalidation.
- The server snapshot is a coarse one-hour cache. It avoids full replay in some
  cases, but it is not a general projection checkpoint system.

The target behavior is:

- First paint should come from a valid local client cache when present.
- A reconnecting browser should request only the event tail after its cached
  cursor.
- The cursor must be part of reducer-produced state, not a separate side cache.
- Applying an event must atomically update both visible state and the cursor.
- A fresh browser with no client cache should get a server materialized state
  quickly, then subscribe to the tail from that server state's cursor.
- Server-side replay should be bounded, ideally to at most the current checkpoint
  window rather than the full historical log.

## Design Principles

1. Events remain append-only facts.

   We do not store computed values in events to make the UI faster. Computed
   state lives only in projections, snapshots, and client caches.

2. Reducers own cursors.

   Each projection state includes the cursor it has reduced through. There is no
   standalone cursor record that can get out of sync with derived state.

3. Cache state by projection, not as one giant page blob.

   Cameras, health, recording timeline, person triage, and debug event views
   have different update rates and size profiles. They should not all be
   rewritten for a heartbeat.

4. Use async browser storage for large state.

   `localStorage` is acceptable for a tiny manifest, but large projection data
   should use IndexedDB so writes do not block rendering.

5. Bound catch-up work on both sides.

   The server should maintain checkpoints and event indexes so reconnects do not
   scan every historical `.jsonl` file.

## Proposed Client Cache Model

Use an IndexedDB database named `patrol-client-state`.

Stores:

- `metadata`
  - key: `manifest`
  - value: cache schema version, reducer version, last write time, and projection
    names.
- `projections`
  - key: projection name, such as `cameras`, `health`, `recordings.timeline`,
    `people.triage`.
  - value: `{ projectionVersion, state, cursor, updatedAtMs }`.
- `events`
  - optional short rolling buffer for debug display only.
  - not authoritative; the event log remains server-side.

Keep only a tiny `localStorage` bootstrap marker:

```json
{
  "dbName": "patrol-client-state",
  "schemaVersion": 1,
  "lastOpenedAtMs": 1780000000000
}
```

This lets the app know whether to try IndexedDB first without storing the large
state synchronously.

## Projection Cursors

Each projection state includes its own cursor:

```ts
type ProjectionSnapshot<TState> = {
  projection: string;
  projectionVersion: number;
  state: TState;
  cursor: EventCursor | null;
  updatedAtMs: number;
};
```

For now, `EventCursor` can remain `{ ts_ms, id }`. Before relying on it
permanently, we should decide whether to include `stream`:

```ts
type EventCursor = {
  stream: "cameras" | "system";
  ts_ms: number;
  id: string;
};
```

Including `stream` makes catch-up unambiguous and avoids edge cases where two
streams contain events with the same timestamp and ID ordering assumptions.

## Client Startup Flow

1. Open IndexedDB.
2. Load cached projection snapshots.
3. Validate cache schema and projection versions.
4. If enough projections are valid, render them immediately.
5. Open the event websocket with the minimum cursor needed for all active
   projections, or with per-projection/per-stream cursors if supported.
6. Apply catch-up events through reducers.
7. Persist updated projection snapshots asynchronously after reduction.

If no valid client cache exists:

1. `GET /api/state/snapshot`.
2. Server returns current materialized projection snapshots and their cursors.
3. Client stores them in IndexedDB.
4. Client renders.
5. Client opens websocket from the returned cursor.

## Event Application Flow

For each received event:

1. Determine which projections care about the event type.
2. Run only those reducers.
3. Each reducer returns a new projection snapshot with the event cursor advanced.
4. Update Svelte state from the changed projections.
5. Queue an async IndexedDB write for those projections only.

This means a system heartbeat updates health and cursors, but does not rewrite
the recordings timeline or people triage cache.

## Server Snapshot Model

Replace the single coarse `.patrol/cache/camera-state.json` with projection
checkpoints:

```text
.patrol/cache/projections/
  cameras.snapshot.json
  health.snapshot.json
  recordings.timeline.snapshot.json
  people.triage.snapshot.json
```

Each snapshot contains:

- projection name
- projection version
- reducer code version
- state
- cursor
- created time
- source event files and offsets if needed

The server may refresh projections continuously in a worker, or lazily on API
request. Either way, it should never require a full event replay for a normal UI
load once checkpoints exist.

## Server Catch-Up Index

The current websocket catch-up scans all event files and filters by cursor. That
will become expensive.

Add a lightweight event file index:

```text
.patrol/cache/event-index/
  cameras-2026-06-19.index.json
  system-2026-06-19.index.json
```

Each index records:

- file name
- first cursor
- last cursor
- byte offsets for periodic cursor checkpoints

On websocket connect:

1. Use the cursor to choose relevant files.
2. Seek near the indexed byte offset.
3. Stream only later events.

This preserves JSONL as the source of truth while avoiding full-file scans.

## Freshness Rules

Client cache validity should depend on version, not age alone.

Invalidate a projection when:

- IndexedDB schema version changes.
- Projection reducer version changes.
- Required state shape validation fails.
- Server reports that the client cursor is too old for catch-up.

Do not invalidate just because the cache is old. Old but valid state can still
render immediately, then catch up.

## Handling Too-Old Cursors

If the client asks for catch-up from a cursor older than the server can serve:

1. Server sends `patrol.event_stream.cursor_expired`.
2. Client requests `/api/state/snapshot`.
3. Client replaces affected projections from server snapshots.
4. Client reconnects from the server snapshot cursor.

This handles long browser absences and event log compaction without corrupting
local state.

## UI Impact

The page should stop treating "hydrated" as a single global boolean. Instead:

- Cameras view can render once `cameras` is available.
- History can render once `recordings.timeline` is available.
- People can render once `people.triage` is available.
- Health can render once `health` is available.

Each view can show its own stale/catching-up indicator based on that projection's
websocket catch-up status.

## Implementation Plan

1. Add projection types and a projection manifest.
2. Split the current large camera reducer output into named projections, while
   keeping shared event parsing helpers.
3. Add an IndexedDB client cache module.
4. Move client startup to:
   - load IndexedDB projections
   - render immediately when valid
   - request server snapshots only for missing/invalid projections
5. Change websocket reconnect to use projection cursors.
6. Add server projection checkpoint files.
7. Add an event-file index for bounded websocket catch-up.
8. Remove full-state `localStorage` writes.
9. Add E2E coverage:
   - first load with no cache uses server snapshot
   - reload with cache renders without `/api/state` before websocket catch-up
   - incoming heartbeat updates health without rewriting recordings cache
   - expired cursor falls back to server snapshot

## Open Questions

- Should the cursor include `stream` now, or can that wait until event indexes
  are introduced?
- Should projection checkpoints be built lazily by the web server or by a
  dedicated reducer worker?
- How much history should the client keep in `recordings.timeline` before asking
  for paged historical projections?
- Should debug live events have a separate short-lived client cache, or should
  they remain memory-only?
