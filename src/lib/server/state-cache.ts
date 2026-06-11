import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CameraStateSnapshot, PatrolEvent } from '$lib/events';
import { reduceCameraDiscoveryEvents } from '$lib/cameras/state-reducer';
import { latestCursorForEvents, readEvents } from '$lib/server/event-store';
import { readSystemEvents } from '$lib/server/system-events';

const CAMERA_STREAM = 'cameras';
const SERVER_STATE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export async function currentCameraStateSnapshot(options: { forceRefresh?: boolean } = {}): Promise<CameraStateSnapshot> {
  if (!options.forceRefresh) {
    const cached = await readCachedCameraStateSnapshot();
    if (cached) {
      return cached;
    }
  }

  const [cameraEvents, systemEvents] = await Promise.all([readEvents(CAMERA_STREAM), readSystemEvents()]);
  const events = [...cameraEvents, ...systemEvents];
  const snapshot = {
    state: reduceCameraDiscoveryEvents(cameraEvents, systemEvents),
    cursor: latestCursorForEvents(events),
    cachedAtMs: Date.now()
  };
  await writeStateSnapshot(snapshot);
  return snapshot;
}

export async function readCachedCameraStateSnapshot(): Promise<CameraStateSnapshot | null> {
  try {
    const snapshot = JSON.parse(await readFile(await stateSnapshotPath(), 'utf8')) as CameraStateSnapshot;
    if (!isCameraStateSnapshot(snapshot)) {
      return null;
    }
    if (Date.now() - snapshot.cachedAtMs > SERVER_STATE_CACHE_MAX_AGE_MS) {
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

async function stateSnapshotPath() {
  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  return path.join(root, 'cache', 'camera-state.json');
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
