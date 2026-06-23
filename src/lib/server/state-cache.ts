import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CameraStateSnapshot, PatrolEvent } from '../events.ts';
import { reduceCameraDiscoveryEvents, reduceCameraStateSnapshotEvent } from '../cameras/state-reducer.ts';
import { compactCameraStateSnapshot } from '../cameras/state-compaction.ts';
import {
  latestCursorForEvents,
  readEventsAfterPosition,
  readEventsWithPosition,
  type EventFilePosition
} from './event-store.ts';

const CAMERA_STREAM = 'cameras';
const SYSTEM_STREAM = 'system';
const SNAPSHOT_STREAMS = [CAMERA_STREAM, SYSTEM_STREAM];
const SERVER_STATE_CHECKPOINT_REWRITE_MS = 5 * 60 * 1000;
const SERVER_STATE_CHECKPOINT_TAIL_EVENT_LIMIT = 1000;
const SERVER_STATE_REQUEST_REPLAY_EVENT_LIMIT = 1000;

interface ServerCameraStateSnapshot extends CameraStateSnapshot {
  serverCache?: {
    version: 1;
    streamPositions: Record<string, EventFilePosition | null>;
  };
}

export async function currentCameraStateSnapshot(
  options: { forceRefresh?: boolean; compactForClient?: boolean } = {}
): Promise<CameraStateSnapshot> {
  if (!options.forceRefresh) {
    const cached = await readCachedCameraStateSnapshot();
    if (cached) {
      return responseSnapshot(cached, options);
    }
  }

  const baseSnapshot = await readCachedCameraStateSnapshot();
  if (baseSnapshot?.serverCache?.version === 1) {
    let snapshot: ServerCameraStateSnapshot = {
      ...baseSnapshot
    };
    const { streamedEvents, streamPositions } = await readStreamedEventsAfterPositions(baseSnapshot.serverCache.streamPositions);
    if (streamedEvents.length > SERVER_STATE_REQUEST_REPLAY_EVENT_LIMIT) {
      return responseSnapshot(baseSnapshot, options);
    }
    for (const streamedEvent of streamedEvents) {
      snapshot = reduceCameraStateSnapshotEvent(snapshot, streamedEvent);
    }
    const response = {
      ...snapshot,
      cachedAtMs: Date.now(),
      serverCache: {
        version: 1 as const,
        streamPositions
      }
    };
    if (shouldRewriteCheckpoint(baseSnapshot, streamedEvents.length)) {
      await writeStateSnapshot(response);
    }
    return responseSnapshot(response, options);
  }

  const {
    cameraEvents,
    systemEvents,
    streamPositions
  } = await readFullSnapshotInputs();
  const events = [...cameraEvents, ...systemEvents];
  const snapshot: ServerCameraStateSnapshot = {
    state: reduceCameraDiscoveryEvents(cameraEvents, systemEvents),
    cursor: latestCursorForEvents(events),
    cachedAtMs: Date.now(),
    serverCache: {
      version: 1,
      streamPositions
    }
  };
  await writeStateSnapshot(snapshot);
  return responseSnapshot(snapshot, options);
}

export async function refreshCameraStateCheckpoint(options: { forceFullReplay?: boolean } = {}) {
  if (options.forceFullReplay) {
    return await writeFullStateSnapshot();
  }

  const baseSnapshot = await readCachedCameraStateSnapshot();
  if (baseSnapshot?.serverCache?.version === 1) {
    let snapshot: ServerCameraStateSnapshot = {
      ...baseSnapshot
    };
    const { streamedEvents, streamPositions } = await readStreamedEventsAfterPositions(baseSnapshot.serverCache.streamPositions);
    for (const streamedEvent of streamedEvents) {
      snapshot = reduceCameraStateSnapshotEvent(snapshot, streamedEvent);
    }
    const response: ServerCameraStateSnapshot = {
      ...snapshot,
      cachedAtMs: Date.now(),
      serverCache: {
        version: 1,
        streamPositions
      }
    };
    await writeStateSnapshot(response);
    return {
      snapshot: response,
      replayedEvents: streamedEvents.length,
      fullReplay: false
    };
  }

  return await writeFullStateSnapshot();
}

export async function readCachedCameraStateSnapshot(options: { maxAgeMs?: number } = {}): Promise<ServerCameraStateSnapshot | null> {
  try {
    const snapshot = JSON.parse(await readFile(await stateSnapshotPath(), 'utf8')) as ServerCameraStateSnapshot;
    if (!isCameraStateSnapshot(snapshot)) {
      return null;
    }
    if (options.maxAgeMs !== undefined && Date.now() - snapshot.cachedAtMs > options.maxAgeMs) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function writeStateSnapshot(snapshot: CameraStateSnapshot) {
  const snapshotPath = await stateSnapshotPath();
  await mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, snapshotPath);
}

async function writeFullStateSnapshot() {
  const {
    cameraEvents,
    systemEvents,
    streamPositions
  } = await readFullSnapshotInputs();
  const events = [...cameraEvents, ...systemEvents];
  const snapshot: ServerCameraStateSnapshot = {
    state: reduceCameraDiscoveryEvents(cameraEvents, systemEvents),
    cursor: latestCursorForEvents(events),
    cachedAtMs: Date.now(),
    serverCache: {
      version: 1,
      streamPositions
    }
  };
  await writeStateSnapshot(snapshot);
  return {
    snapshot,
    replayedEvents: events.length,
    fullReplay: true
  };
}

async function readFullSnapshotInputs() {
  const [cameraRead, systemRead] = await Promise.all(
    SNAPSHOT_STREAMS.map(async (stream) => ({
      stream,
      ...(await readEventsWithPosition(stream))
    }))
  );

  return {
    cameraEvents: cameraRead.events,
    systemEvents: systemRead.events,
    streamPositions: {
      [cameraRead.stream]: cameraRead.position,
      [systemRead.stream]: systemRead.position
    }
  };
}

async function readStreamedEventsAfterPositions(streamPositions: Record<string, EventFilePosition | null>) {
  const reads = await Promise.all(
    SNAPSHOT_STREAMS.map(async (stream) => ({
      stream,
      ...(await readEventsAfterPosition(stream, streamPositions[stream] ?? null))
    }))
  );

  return {
    streamedEvents: reads
      .flatMap((read) => read.events.map((event) => ({ stream: read.stream, event })))
      .sort((left, right) => left.event.ts_ms - right.event.ts_ms || left.event.id.localeCompare(right.event.id)),
    streamPositions: Object.fromEntries(reads.map((read) => [read.stream, read.position]))
  };
}

function responseSnapshot(
  snapshot: ServerCameraStateSnapshot,
  options: { compactForClient?: boolean } = {}
): CameraStateSnapshot {
  const { serverCache: _serverCache, ...clientSnapshot } = snapshot;
  return options.compactForClient === false ? clientSnapshot : compactCameraStateSnapshot(clientSnapshot);
}

function shouldRewriteCheckpoint(snapshot: ServerCameraStateSnapshot, tailEventCount: number) {
  if (tailEventCount === 0) {
    return false;
  }

  return (
    Date.now() - snapshot.cachedAtMs >= SERVER_STATE_CHECKPOINT_REWRITE_MS ||
    tailEventCount >= SERVER_STATE_CHECKPOINT_TAIL_EVENT_LIMIT
  );
}

async function stateSnapshotPath() {
  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  return path.join(root, 'cache', 'server-camera-state.json');
}

function isCameraStateSnapshot(value: unknown): value is CameraStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CameraStateSnapshot> & { cursor?: unknown };
  return (
    Boolean(candidate.state) &&
    typeof candidate.cachedAtMs === 'number' &&
    (candidate.cursor === null || isPatrolEventCursor(candidate.cursor))
  );
}

function isPatrolEventCursor(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Partial<PatrolEvent>;
  return typeof cursor.ts_ms === 'number' && typeof cursor.id === 'string';
}
