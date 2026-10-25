import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { recordingFfmpegArgs } from './lib/recorder-ffmpeg.mjs';
import { delay } from './lib/async.mjs';
import {
  appendCameraEvent,
  appendCameraEvents,
  appendProcessExited,
  startProcessHeartbeats
} from './lib/patrol-events.mjs';
import { patrolDataRoot, patrolRecordingsDir } from './lib/patrol-paths.mjs';
import {
  finalizeStagedRecording,
  ffmpegRecordingPattern,
  parseFfmpegCompletedSegment,
  probeRecordingFile,
  waitForStableRecording
} from './lib/recording-files.mjs';
import {
  openRecordingCatalog,
  syncRecordingCatalogFromEvents
} from '../src/lib/server/recording-catalog.ts';

const dataRoot = patrolDataRoot();
const eventsDir = path.join(dataRoot, 'events');
const secretsDir = path.join(dataRoot, 'secrets');
const cacheDir = path.join(dataRoot, 'cache');
const recordingsDir = patrolRecordingsDir(dataRoot);
const go2rtcRtspBaseUrl = process.env.PATROL_GO2RTC_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554';
const segmentSeconds = Number(process.env.PATROL_RECORDING_SEGMENT_SECONDS ?? '60');
const restartDelayMs = Number(process.env.PATROL_RECORDING_RESTART_DELAY_MS ?? '250');
const restartMaxDelayMs = Number(process.env.PATROL_RECORDING_RESTART_MAX_DELAY_MS ?? '5000');
const mainRetentionMs = Number(process.env.PATROL_MAIN_RECORDING_RETENTION_DAYS ?? '7') * 24 * 60 * 60 * 1000;
const subRetentionMs = Number(process.env.PATROL_SUB_RECORDING_RETENTION_DAYS ?? '30') * 24 * 60 * 60 * 1000;
const retentionEnabled = !['0', 'false', 'no', 'off'].includes(
  String(process.env.PATROL_RECORDING_RETENTION_ENABLED ?? 'true').toLowerCase()
);
const ageRetentionEnabled = !['0', 'false', 'no', 'off'].includes(
  String(process.env.PATROL_RECORDING_AGE_RETENTION_ENABLED ?? 'true').toLowerCase()
);
const recoveryEnabled = !['0', 'false', 'no', 'off'].includes(
  String(process.env.PATROL_RECORDING_RECOVERY_ENABLED ?? 'true').toLowerCase()
);
const cleanupOnly = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.PATROL_RECORDING_CLEANUP_ONLY ?? 'false').toLowerCase()
);
const segmentSettleMs = Number(process.env.PATROL_RECORDING_SEGMENT_SETTLE_MS ?? '250');
const segmentFinalizeTimeoutMs = Number(process.env.PATROL_RECORDING_FINALIZE_TIMEOUT_MS ?? '120000');
const streamStallTimeoutMs = Number(process.env.PATROL_RECORDING_STALL_TIMEOUT_MS ?? '90000');
const retentionSweepMs = Number(process.env.PATROL_RECORDING_RETENTION_SWEEP_MS ?? String(10 * 1000));
const configuredRetentionBatchSize = Number(process.env.PATROL_RECORDING_RETENTION_BATCH_SIZE ?? '1000');
const retentionBatchSize = Math.max(
  1,
  Math.floor(Number.isFinite(configuredRetentionBatchSize) ? configuredRetentionBatchSize : 250)
);
const configuredPressureBatchSize = Number(process.env.PATROL_RECORDING_PRESSURE_BATCH_SIZE ?? '2000');
const pressureBatchSize = Math.max(
  1,
  Math.floor(Number.isFinite(configuredPressureBatchSize) ? configuredPressureBatchSize : 250)
);
const storageLowWatermark = boundedRatio(
  process.env.PATROL_RECORDING_STORAGE_LOW_WATERMARK_PERCENT,
  10
);
const storageHighWatermark = Math.max(
  storageLowWatermark,
  boundedRatio(process.env.PATROL_RECORDING_STORAGE_HIGH_WATERMARK_PERCENT, 15)
);
const configuredDeleteConcurrency = Number(process.env.PATROL_RECORDING_DELETE_CONCURRENCY ?? '1');
const deleteConcurrency = Math.max(
  1,
  Math.floor(Number.isFinite(configuredDeleteConcurrency) ? configuredDeleteConcurrency : 1)
);
const configuredDeleteDelayMs = Number(process.env.PATROL_RECORDING_DELETE_DELAY_MS ?? '3000');
const deleteDelayMs = Math.max(
  0,
  Math.floor(Number.isFinite(configuredDeleteDelayMs) ? configuredDeleteDelayMs : 3000)
);

await assertExternalRecordingVolumeMounted(recordingsDir);
await mkdir(recordingsDir, { recursive: true, mode: 0o700 });

const cameras = await configuredCameras();
const streams = cameras.flatMap((camera) => [
  { camera, role: 'main', streamName: camera.streams.main },
  { camera, role: 'sub', streamName: camera.streams.sub }
]);
await Promise.all(
  streams.map(({ streamName }) => mkdir(path.join(recordingsDir, '.staging', streamName), { recursive: true, mode: 0o700 }))
);
const catalog = await openRecordingCatalog(dataRoot, { recoverCorrupt: true });
let stopping = false;
let shuttingDown = false;
let retentionSweepInFlight = false;
let storagePressureActive = false;

const heartbeat = cleanupOnly ? null : startProcessHeartbeats({
  processId: 'patrol-recorder',
  label: 'Recording worker',
  kind: 'worker',
  detail: `Recording ${cameras.length} configured camera${cameras.length === 1 ? '' : 's'}`
});

let children = [];
const retentionInterval = retentionEnabled && !cleanupOnly
  ? setInterval(() => {
      void sweepRetentionIfIdle();
    }, retentionSweepMs)
  : null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopping = true;
    void shutdown(128 + signalNumber(signal), signal);
  });
}

const catalogSync = await syncRecordingCatalogFromEvents(catalog, eventsDir);
console.error(`recording catalog synchronized ${catalogSync.eventsApplied} event(s) from ${catalogSync.filesRead} file(s)`);
if (cleanupOnly) {
  try {
    await sweepRetentionIfIdle({ forcePressure: true });
  } finally {
    catalog.close();
  }
  process.exit(0);
}
const stagedSegmentsToRecover = recoveryEnabled ? await listStagedSegmentsToRecover() : [];
startRecorderChildren();
await recoverStagedSegments(stagedSegmentsToRecover);

if (retentionEnabled) {
  void sweepRetentionIfIdle();
}

if (children.length === 0) {
  console.error('patrol-recorder found no configured cameras; staying alive for health visibility');
}

function startRecorder(camera, role, streamName) {
  const streamUrl = `${go2rtcRtspBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(streamName)}`;
  let child = null;
  let restartTimer = null;
  let restartAttempts = 0;
  let launchSequence = 0;
  let interrupted = false;
  let continuityId = null;
  let logicalEndMs = null;
  let lastCompletionAtMs = Date.now();
  let finalizationQueue = Promise.resolve();
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const launch = () => {
    if (stopping) {
      return;
    }

    const launchId = `${process.pid}-${Date.now()}-${launchSequence}`;
    launchSequence += 1;
    lastCompletionAtMs = Date.now();
    const outputPattern = ffmpegRecordingPattern(recordingsDir, streamName, launchId);
    child = spawn('ffmpeg', recordingFfmpegArgs({ streamUrl, segmentSeconds, outputPattern }), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.error(`recording ${role} stream ${streamName} from ${streamUrl}`);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const errorLines = forwardRateLimitedLines(child.stderr, `ffmpeg ${streamName}`);
    lines.on('line', (line) => {
      const completed = parseFfmpegCompletedSegment(line);
      if (!completed) {
        return;
      }
      lastCompletionAtMs = Date.now();
      finalizationQueue = finalizationQueue
        .then(() => finalizeSegment(completed.fileName, launchId))
        .catch(async (error) => {
          console.error(`recording finalization failed for ${streamName}:`, error);
          await markInterrupted(`Could not finalize ${streamName}: ${error instanceof Error ? error.message : String(error)}`);
        });
    });

    child.on('exit', (exitCode, signal) => {
      lines.close();
      errorLines.close();
      child = null;
      if (stopping) {
        void finalizationQueue.finally(resolveStopped);
        return;
      }

      void markInterrupted(
        `FFmpeg exited with code ${exitCode ?? 'null'} signal ${signal ?? 'null'}`,
        exitCode,
        signal
      );
      const delayMs = Math.min(restartMaxDelayMs, restartDelayMs * (2 ** Math.min(restartAttempts, 6)));
      restartAttempts += 1;
      console.error(
        `ffmpeg recorder for ${streamName} exited with code ${exitCode ?? 'null'} signal ${signal ?? 'null'}; restarting in ${delayMs} ms`
      );
      restartTimer = setTimeout(launch, delayMs);
    });
  };

  const stallInterval = setInterval(() => {
    if (!child || stopping || Date.now() - lastCompletionAtMs <= streamStallTimeoutMs) {
      return;
    }
    const stalledChild = child;
    lastCompletionAtMs = Date.now();
    void markInterrupted(`No finalized segment for ${streamStallTimeoutMs} ms`);
    stalledChild.kill('SIGTERM');
  }, Math.min(10_000, Math.max(1000, Math.floor(streamStallTimeoutMs / 3))));

  async function finalizeSegment(fileName, launchId) {
    const stagingPath = path.join(recordingsDir, '.staging', streamName, fileName);
    const segment = await persistStagedSegment({
      camera,
      role,
      streamName,
      stagingPath,
      preferredStartMs: continuityId === launchId ? logicalEndMs : null
    });
    continuityId = launchId;
    logicalEndMs = segment.startMs + segment.durationMs;
    restartAttempts = 0;
    if (interrupted) {
      await appendCameraEvent({
        type: 'recording.stream.recovered',
        source: 'patrol-recorder',
        payload: { cameraId: camera.id, role, streamName, recoveredAtMs: Date.now() }
      });
      interrupted = false;
    }
  }

  async function markInterrupted(detail, exitCode = null, signal = null) {
    if (interrupted || stopping) {
      return;
    }
    interrupted = true;
    try {
      await appendCameraEvent({
        type: 'recording.stream.interrupted',
        source: 'patrol-recorder',
        payload: {
          cameraId: camera.id,
          role,
          streamName,
          interruptedAtMs: Date.now(),
          exitCode,
          signal,
          detail
        }
      });
    } catch (error) {
      console.error(`failed to record interruption for ${streamName}:`, error);
    }
  }

  launch();

  return {
    stop(signal) {
      clearInterval(stallInterval);
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!child) {
        void finalizationQueue.finally(resolveStopped);
        return stopped;
      }

      const childToStop = child;
      const forceStop = setTimeout(() => {
        if (child === childToStop) {
          childToStop.kill('SIGKILL');
        }
      }, 10_000);
      childToStop.once('exit', () => clearTimeout(forceStop));
      childToStop.kill(signal);
      return stopped;
    }
  };
}

async function listStagedSegmentsToRecover() {
  const stagedSegments = [];
  for (const { camera, role, streamName } of streams) {
    const stagingDir = path.join(recordingsDir, '.staging', streamName);
    let entries;
    try {
      entries = await readdir(stagingDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error(`could not inspect staged recordings for ${streamName}:`, error);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.m4v')) {
        continue;
      }
      stagedSegments.push({
        camera,
        role,
        streamName,
        fileName: entry.name,
        stagingPath: path.join(stagingDir, entry.name)
      });
    }
  }
  return stagedSegments;
}

async function recoverStagedSegments(stagedSegments) {
  for (const { camera, role, streamName, fileName, stagingPath } of stagedSegments) {
    try {
      const segment = await persistStagedSegment({
        camera,
        role,
        streamName,
        stagingPath,
        preferredStartMs: null
      });
      console.error(`recovered staged recording ${segment.relativePath}`);
    } catch (error) {
      console.error(`could not recover staged recording ${streamName}/${fileName}:`, error);
      try {
        const rejectedPath = `${stagingPath}.rejected-${Date.now()}`;
        await rename(stagingPath, rejectedPath);
        console.error(`quarantined unusable staged recording ${streamName}/${path.basename(rejectedPath)}`);
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') {
          console.error(`could not quarantine unusable staged recording ${streamName}/${fileName}:`, renameError);
        }
      }
    }
    if (deleteDelayMs > 0 && !stopping) {
      await delay(deleteDelayMs);
    }
  }
}

async function persistStagedSegment({ camera, role, streamName, stagingPath, preferredStartMs }) {
  const stats = await waitForStableRecording(stagingPath, {
    pollMs: segmentSettleMs,
    timeoutMs: segmentFinalizeTimeoutMs
  });
  const media = await probeRecordingFile(stagingPath, { timeoutMs: segmentFinalizeTimeoutMs });
  const finalized = await finalizeStagedRecording(
    recordingsDir,
    streamName,
    stagingPath,
    preferredStartMs ?? (stats.birthtimeMs > 0 ? stats.birthtimeMs : Date.now() - media.durationMs)
  );
  const segment = {
    cameraId: camera.id,
    role,
    streamName,
    startMs: finalized.startMs,
    durationMs: media.durationMs,
    sizeBytes: media.sizeBytes,
    relativePath: finalized.relativePath,
    observedAtMs: Date.now()
  };
  await appendCameraEvent({
    type: 'recording.segment.observed',
    source: 'patrol-recorder',
    payload: {
      cameraId: segment.cameraId,
      role: segment.role,
      streamName: segment.streamName,
      startMs: segment.startMs,
      durationMs: segment.durationMs,
      sizeBytes: segment.sizeBytes,
      relativePath: segment.relativePath
    }
  });
  catalog.upsertSegment(segment);
  return segment;
}

async function sweepRetentionIfIdle({ forcePressure = false } = {}) {
  if (!retentionEnabled || retentionSweepInFlight || stopping) {
    return;
  }
  retentionSweepInFlight = true;
  let pausedForPressure = false;
  try {
    const nowMs = Date.now();
    let ageExpired = 0;
    let ageReclaimedBytes = 0;
    while (ageRetentionEnabled && !stopping) {
      const expired = catalog.segmentsPastRetention(
        nowMs - mainRetentionMs,
        nowMs - subRetentionMs,
        retentionBatchSize
      );
      if (expired.length === 0) {
        break;
      }
      const expiredBatch = await expireSegments(expired, nowMs, 'age');
      ageExpired += expiredBatch.count;
      ageReclaimedBytes += expiredBatch.bytes;
      console.error(
        `recording age retention progress: ${ageExpired} segment(s), ` +
        `${formatBytes(ageReclaimedBytes)} catalogued`
      );
      if (expiredBatch.count === 0) {
        break;
      }
      if (cleanupOnly && (await recordingStorageUsage()).availableRatio >= storageHighWatermark) {
        break;
      }
    }

    let storage = await recordingStorageUsage();
    if (
      !storagePressureActive &&
      (storage.availableRatio < storageLowWatermark || (forcePressure && storage.availableRatio < storageHighWatermark))
    ) {
      storagePressureActive = true;
      console.error(
        `recording storage pressure started at ${(storage.availableRatio * 100).toFixed(1)}% free; ` +
        `target ${(storageHighWatermark * 100).toFixed(1)}%`
      );
    } else if (storagePressureActive && storage.availableRatio >= storageHighWatermark) {
      storagePressureActive = false;
      console.error(`recording storage pressure cleared at ${(storage.availableRatio * 100).toFixed(1)}% free`);
    }

    if (!cleanupOnly && storagePressureActive && storage.availableRatio < storageHighWatermark) {
      await stopRecorderChildren('SIGTERM');
      pausedForPressure = true;
      console.error('recording paused while storage pressure cleanup reclaims space');
    }

    let totalReclaimedBytes = 0;
    let totalExpired = 0;
    while (storagePressureActive && storage.availableRatio < storageHighWatermark) {
      const pressured = catalog.segmentsForStoragePressure(nowMs - mainRetentionMs, pressureBatchSize);
      if (pressured.length === 0) {
        console.error('recording storage pressure cannot reclaim more data without violating main-stream retention');
        break;
      }
      const expiredBatch = await expireSegments(pressured, nowMs, 'storage-pressure');
      totalExpired += expiredBatch.count;
      totalReclaimedBytes += expiredBatch.bytes;
      storage = await recordingStorageUsage();
      console.error(
        `recording storage pressure progress: ${totalExpired} segment(s), ` +
        `${formatBytes(totalReclaimedBytes)} catalogued, ${(storage.availableRatio * 100).toFixed(1)}% free`
      );
      if (expiredBatch.count === 0 || stopping) {
        break;
      }
    }
    if (storagePressureActive && storage.availableRatio >= storageHighWatermark) {
      storagePressureActive = false;
      console.error(`recording storage pressure cleared at ${(storage.availableRatio * 100).toFixed(1)}% free`);
    }
  } catch (error) {
    console.error('recording retention sweep failed:', error);
  } finally {
    if (pausedForPressure && !stopping) {
      startRecorderChildren();
      console.error('recording resumed after storage pressure cleanup');
    }
    retentionSweepInFlight = false;
  }
}

function startRecorderChildren() {
  children = streams.map(({ camera, role, streamName }) => startRecorder(camera, role, streamName));
}

async function stopRecorderChildren(signal) {
  const activeChildren = children;
  children = [];
  await Promise.all(activeChildren.map((child) => child.stop(signal)));
}

async function expireSegments(segments, nowMs, reason) {
  if (segments.length === 0) {
    return { count: 0, bytes: 0 };
  }
  const deleted = [];
  await mapWithConcurrency(segments, deleteConcurrency, async (segment) => {
    try {
      await unlink(path.join(recordingsDir, segment.relativePath));
      deleted.push(segment);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        deleted.push(segment);
      } else {
        console.error(`could not expire recording ${segment.relativePath}:`, error);
      }
    }
  });
  if (deleted.length === 0) {
    return { count: 0, bytes: 0 };
  }
  await appendCameraEvents(deleted.map((segment) => ({
    type: 'recording.segment.expired',
    source: 'patrol-recorder',
    payload: {
      cameraId: segment.cameraId,
      role: segment.role,
      streamName: segment.streamName,
      startMs: segment.startMs,
      relativePath: segment.relativePath,
      retentionDays: segment.role === 'main'
        ? Math.round(mainRetentionMs / (24 * 60 * 60 * 1000))
        : Math.round(subRetentionMs / (24 * 60 * 60 * 1000)),
      reason
    }
  })));
  catalog.expireSegments(deleted.map((segment) => segment.relativePath), nowMs);
  return {
    count: deleted.length,
    bytes: deleted.reduce((total, segment) => total + segment.sizeBytes, 0)
  };
}

async function mapWithConcurrency(items, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index]);
      if (deleteDelayMs > 0 && nextIndex < items.length) {
        await delay(deleteDelayMs);
      }
    }
  });
  await Promise.all(workers);
}

async function recordingStorageUsage() {
  const storage = await statfs(recordingsDir);
  const totalBytes = storage.blocks * storage.bsize;
  const availableBytes = storage.bavail * storage.bsize;
  return {
    totalBytes,
    availableBytes,
    availableRatio: totalBytes > 0 ? availableBytes / totalBytes : 0
  };
}

function boundedRatio(rawPercent, fallbackPercent) {
  const parsed = Number(rawPercent ?? fallbackPercent);
  const percent = Number.isFinite(parsed) ? parsed : fallbackPercent;
  return Math.min(100, Math.max(0, percent)) / 100;
}

async function assertExternalRecordingVolumeMounted(targetDir) {
  const volumesRoot = path.resolve('/Volumes');
  const relativePath = path.relative(volumesRoot, path.resolve(targetDir));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return;
  }
  const [volumeName] = relativePath.split(path.sep);
  if (!volumeName) {
    throw new Error(`recordings directory must name a mounted volume below ${volumesRoot}: ${targetDir}`);
  }
  const volumeRoot = path.join(volumesRoot, volumeName);
  let volumesStats;
  let volumeStats;
  try {
    [volumesStats, volumeStats] = await Promise.all([stat(volumesRoot), stat(volumeRoot)]);
  } catch (error) {
    throw new Error(`recording volume is not mounted at ${volumeRoot}`, { cause: error });
  }
  if (volumesStats.dev === volumeStats.dev) {
    throw new Error(`recording volume is not mounted at ${volumeRoot}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function forwardRateLimitedLines(stream, label) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let emitted = 0;
  let suppressed = 0;
  let windowStartedAt = Date.now();
  const flush = () => {
    if (suppressed > 0) {
      console.error(`${label}: suppressed ${suppressed} repeated diagnostic line(s)`);
    }
    emitted = 0;
    suppressed = 0;
    windowStartedAt = Date.now();
  };
  lines.on('line', (line) => {
    if (Date.now() - windowStartedAt >= 60_000) {
      flush();
    }
    if (emitted < 10) {
      console.error(`${label}: ${line}`);
      emitted += 1;
    } else {
      suppressed += 1;
    }
  });
  lines.on('close', flush);
  return lines;
}

async function configuredCameras() {
  try {
    const checkpoint = JSON.parse(await readFile(path.join(cacheDir, 'server-camera-state.json'), 'utf8'));
    const devices = checkpoint?.state?.devices;
    if (Array.isArray(devices)) {
      return devices
        .filter((camera) => camera?.id && camera?.credentials && camera?.streams?.main && camera?.streams?.sub)
        .map((camera) => ({
          id: camera.id,
          remoteAddress: camera.remoteAddress ?? null,
          streams: {
            main: camera.streams.main,
            sub: camera.streams.sub
          }
        }));
    }
  } catch {
    // Fall back to event replay when no valid state checkpoint exists yet.
  }

  const cameras = reduceCameras(await readJsonlDir(eventsDir, 'cameras-'));
  const secrets = latestSecretsByCamera(await readJsonlDir(secretsDir, 'secrets-'));
  return cameras.filter((camera) => secrets.has(camera.id));
}

async function readJsonlDir(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const events = [];
  for (const entry of entries.filter((fileName) => fileName.startsWith(prefix)).sort()) {
    const filePath = path.join(dir, entry);
    try {
      await access(filePath, fsConstants.R_OK);
    } catch {
      continue;
    }
    const content = await readFile(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim()) {
        events.push(JSON.parse(line));
      }
    }
  }
  return events.sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));
}

function reduceCameras(events) {
  const camerasById = new Map();
  const configuredCameraIds = new Set();

  for (const event of events) {
    if (event.type === 'camera.credentials.saved') {
      configuredCameraIds.add(event.payload.cameraId);
      continue;
    }

    if (event.type !== 'camera.discovery.completed') {
      continue;
    }

    const responses = event.payload.rawResult?.responses ?? [];
    for (const response of responses) {
      const camera = parseProbeResponse(response);
      camerasById.set(camera.id, camera);
    }
  }

  return Array.from(camerasById.values()).filter((camera) => configuredCameraIds.has(camera.id));
}

function parseProbeResponse(response) {
  const xaddrs = splitWords(textForTag(response.body, 'XAddrs'));
  const scopes = splitWords(textForTag(response.body, 'Scopes')).map(decodeScope);
  const endpoint = textForTag(response.body, 'Address');
  const id = endpoint ?? xaddrs[0] ?? `udp:${response.remoteAddress}`;

  return {
    id,
    remoteAddress: response.remoteAddress,
    streams: streamNames(scopes, response.remoteAddress, id)
  };
}

function latestSecretsByCamera(events) {
  const secrets = new Map();
  for (const event of events) {
    if (event.type === 'secret.camera.credentials.set') {
      secrets.set(event.camera_id, event.payload);
    }
  }
  return secrets;
}

function textForTag(xml, tagName) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

function splitWords(value) {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function decodeScope(scope) {
  try {
    return decodeURIComponent(scope);
  } catch {
    return scope;
  }
}

function scopeValue(scopes, marker) {
  const match = scopes.find((scope) => scope.includes(marker));
  if (!match) {
    return null;
  }

  const [, value] = match.split(marker);
  return value ? value.replace(/\+/g, ' ') : null;
}

function streamNames(scopes, remoteAddress, id) {
  const rawName = scopeValue(scopes, '/name/') ?? scopeValue(scopes, '/hardware/') ?? remoteAddress ?? id;
  const baseName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const streamBase = baseName || `camera_${Math.abs(hashString(id))}`;
  return {
    main: `${streamBase}_main`,
    sub: `${streamBase}_sub`
  };
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function shutdown(exitCode, signal) {
  clearInterval(heartbeat);
  if (retentionInterval) {
    clearInterval(retentionInterval);
  }
  await Promise.all(children.map((child) => child.stop(signal)));
  try {
    await appendProcessExited({
      processId: 'patrol-recorder',
      label: 'Recording worker',
      kind: 'worker',
      exitCode,
      signal,
      detail: 'Recording worker stopped'
    });
  } finally {
    catalog.close();
    process.exit(exitCode);
  }
}

function signalNumber(signal) {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    default:
      return 1;
  }
}
