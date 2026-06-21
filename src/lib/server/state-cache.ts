import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CameraStateSnapshot, PatrolEvent } from '$lib/events';
import { reduceCameraDiscoveryEvents, reduceCameraStateSnapshotEvent } from '$lib/cameras/state-reducer';
import { compactCameraStateSnapshot } from '$lib/cameras/state-compaction';
import {
  latestCursorForEvents,
  readEventsAfterPosition,
  readEventsWithPosition,
  type EventFilePosition
} from '$lib/server/event-store';

const CAMERA_STREAM = 'cameras';
const SYSTEM_STREAM = 'system';
const SNAPSHOT_STREAMS = [CAMERA_STREAM, SYSTEM_STREAM];
const SERVER_STATE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

interface ServerCameraStateSnapshot extends CameraStateSnapshot {
  serverCache?: {
    version: 1;
    streamPositions: Record<string, EventFilePosition | null>;
  };
}

export async function currentCameraStateSnapshot(options: { forceRefresh?: boolean } = {}): Promise<CameraStateSnapshot> {
  if (!options.forceRefresh) {
    const cached = await readCachedCameraStateSnapshot({ maxAgeMs: SERVER_STATE_CACHE_MAX_AGE_MS });
    if (cached) {
      return responseSnapshot(cached);
    }
  }

  const baseSnapshot = await readCachedCameraStateSnapshot();
  if (baseSnapshot?.serverCache?.version === 1) {
    let snapshot: ServerCameraStateSnapshot = {
      ...baseSnapshot,
      cachedAtMs: Date.now()
    };
    const { streamedEvents, streamPositions } = await readStreamedEventsAfterPositions(baseSnapshot.serverCache.streamPositions);
    for (const streamedEvent of streamedEvents) {
      snapshot = reduceCameraStateSnapshotEvent(snapshot, streamedEvent);
    }
    snapshot = {
      ...snapshot,
      cachedAtMs: Date.now(),
      serverCache: {
        version: 1,
        streamPositions
      }
    };
    if (streamedEvents.length > 0 || snapshot.cursor?.id !== baseSnapshot.cursor?.id) {
      await writeStateSnapshot(snapshot);
    }
    return responseSnapshot(snapshot);
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
  return responseSnapshot(snapshot);
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
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
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

function responseSnapshot(snapshot: ServerCameraStateSnapshot): CameraStateSnapshot {
  const { serverCache: _serverCache, ...clientSnapshot } = snapshot;
  return compactCameraStateSnapshot(clientSnapshot);
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
