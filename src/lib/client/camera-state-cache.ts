import type { CameraStateSnapshot, EventCursor } from '$lib/events';

const DB_NAME = 'patrol-client-state';
const DB_VERSION = 1;
const PROJECTION_STORE = 'projections';
const CAMERA_STATE_KEY = 'camera-state';
const PROJECTION_VERSION = 1;
const LOCAL_STORAGE_MARKER_KEY = 'patrol.client_state_cache.v1';
const LEGACY_LOCAL_STORAGE_STATE_KEY = 'patrol.camera_state.v2';
const WRITE_DEBOUNCE_MS = 250;

interface CameraStateProjectionRecord {
  key: typeof CAMERA_STATE_KEY;
  projection: typeof CAMERA_STATE_KEY;
  projectionVersion: number;
  snapshot: CameraStateSnapshot;
  updatedAtMs: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let pendingSnapshot: CameraStateSnapshot | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadCachedCameraStateSnapshot(): Promise<CameraStateSnapshot | null> {
  if (!browserStorageAvailable()) {
    return null;
  }

  try {
    const db = await openDatabase();
    const record = await getRecord<CameraStateProjectionRecord>(db, PROJECTION_STORE, CAMERA_STATE_KEY);
    if (!isCameraStateProjectionRecord(record)) {
      return loadLegacyCameraStateSnapshot();
    }
    return record.snapshot;
  } catch {
    return loadLegacyCameraStateSnapshot();
  }
}

export function scheduleCameraStateSnapshotPersist(snapshot: CameraStateSnapshot) {
  if (!browserStorageAvailable()) {
    return;
  }

  pendingSnapshot = snapshot;
  if (writeTimer) {
    return;
  }

  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushPendingCameraStateSnapshot();
  }, WRITE_DEBOUNCE_MS);
}

export async function flushPendingCameraStateSnapshot() {
  if (!pendingSnapshot || !browserStorageAvailable()) {
    return;
  }

  const snapshot = pendingSnapshot;
  pendingSnapshot = null;

  try {
    const db = await openDatabase();
    await putRecord(db, PROJECTION_STORE, {
      key: CAMERA_STATE_KEY,
      projection: CAMERA_STATE_KEY,
      projectionVersion: PROJECTION_VERSION,
      snapshot,
      updatedAtMs: Date.now()
    } satisfies CameraStateProjectionRecord);
    writeCacheMarker();
  } catch {
    pendingSnapshot = snapshot;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTION_STORE)) {
        db.createObjectStore(PROJECTION_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open Patrol client cache.'));
    request.onblocked = () => reject(new Error('Patrol client cache upgrade is blocked by another tab.'));
  });

  return dbPromise;
}

function getRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error(`Unable to read ${storeName}.`));
    transaction.onerror = () => reject(transaction.error ?? new Error(`Unable to read ${storeName}.`));
  });
}

function putRecord<T extends { key: IDBValidKey }>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(value);
    request.onerror = () => reject(request.error ?? new Error(`Unable to write ${storeName}.`));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`Unable to write ${storeName}.`));
  });
}

function browserStorageAvailable() {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function writeCacheMarker() {
  try {
    window.localStorage.setItem(
      LOCAL_STORAGE_MARKER_KEY,
      JSON.stringify({
        dbName: DB_NAME,
        schemaVersion: DB_VERSION,
        projectionVersion: PROJECTION_VERSION,
        lastOpenedAtMs: Date.now()
      })
    );
  } catch {
    // The IndexedDB projection remains authoritative for the browser cache.
  }
}

function loadLegacyCameraStateSnapshot() {
  try {
    const rawCache = window.localStorage.getItem(LEGACY_LOCAL_STORAGE_STATE_KEY);
    if (!rawCache) {
      return null;
    }

    const snapshot = JSON.parse(rawCache) as CameraStateSnapshot;
    if (!isCameraStateSnapshot(snapshot)) {
      window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_STATE_KEY);
      return null;
    }

    scheduleCameraStateSnapshotPersist(snapshot);
    window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_STATE_KEY);
    return snapshot;
  } catch {
    try {
      window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_STATE_KEY);
    } catch {
      // Ignore localStorage cleanup errors.
    }
    return null;
  }
}

function isCameraStateProjectionRecord(value: unknown): value is CameraStateProjectionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<CameraStateProjectionRecord>;
  return (
    record.key === CAMERA_STATE_KEY &&
    record.projection === CAMERA_STATE_KEY &&
    record.projectionVersion === PROJECTION_VERSION &&
    isCameraStateSnapshot(record.snapshot)
  );
}

function isCameraStateSnapshot(value: unknown): value is CameraStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CameraStateSnapshot>;
  return Boolean(candidate.state) && typeof candidate.cachedAtMs === 'number' && isEventCursorOrNull(candidate.cursor);
}

function isEventCursorOrNull(value: unknown): value is EventCursor | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Partial<EventCursor>;
  return typeof cursor.ts_ms === 'number' && typeof cursor.id === 'string';
}
