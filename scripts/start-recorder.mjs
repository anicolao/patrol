import { spawn } from 'node:child_process';
import { constants as fsConstants, watch } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  appendCameraEvent,
  appendProcessExited,
  startProcessHeartbeats
} from './lib/patrol-events.mjs';
import { patrolDataRoot, patrolRecordingsDir } from './lib/patrol-paths.mjs';
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
const segmentSeconds = Number(process.env.PATROL_RECORDING_SEGMENT_SECONDS ?? '15');
const restartDelayMs = Number(process.env.PATROL_RECORDING_RESTART_DELAY_MS ?? '5000');
const mainRetentionMs = Number(process.env.PATROL_MAIN_RECORDING_RETENTION_DAYS ?? '7') * 24 * 60 * 60 * 1000;
const subRetentionMs = Number(process.env.PATROL_SUB_RECORDING_RETENTION_DAYS ?? '30') * 24 * 60 * 60 * 1000;
const retentionEnabled = !['0', 'false', 'no', 'off'].includes(
  String(process.env.PATROL_RECORDING_RETENTION_ENABLED ?? 'true').toLowerCase()
);
const segmentSettleMs = Number(process.env.PATROL_RECORDING_SEGMENT_SETTLE_MS ?? '5000');
const minimumSegmentBytes = Number(process.env.PATROL_RECORDING_MIN_SEGMENT_BYTES ?? String(256 * 1024));
const retentionSweepMs = Number(process.env.PATROL_RECORDING_RETENTION_SWEEP_MS ?? String(60 * 60 * 1000));

await mkdir(recordingsDir, { recursive: true, mode: 0o700 });

const cameras = await configuredCameras();
const streams = cameras.flatMap((camera) => [
  { camera, role: 'main', streamName: camera.streams.main },
  { camera, role: 'sub', streamName: camera.streams.sub }
]);
await Promise.all(
  streams.map(({ streamName }) => mkdir(path.join(recordingsDir, streamName), { recursive: true, mode: 0o700 }))
);
const catalog = await openRecordingCatalog(dataRoot);
let stopping = false;
let shuttingDown = false;
let retentionSweepInFlight = false;

const heartbeat = startProcessHeartbeats({
  processId: 'patrol-recorder',
  label: 'Recording worker',
  kind: 'worker',
  detail: `Recording ${cameras.length} configured camera${cameras.length === 1 ? '' : 's'}`
});

const observers = streams.map(startRecordingObserver);
const children = streams.map(({ camera, role, streamName }) => startRecorder(camera, role, streamName));
const retentionInterval = retentionEnabled
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

if (retentionEnabled) {
  void sweepRetentionIfIdle();
}

if (children.length === 0) {
  console.error('patrol-recorder found no configured cameras; staying alive for health visibility');
}

function startRecorder(camera, role, streamName) {
  const streamDir = path.join(recordingsDir, streamName);
  const streamUrl = `${go2rtcRtspBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(streamName)}`;
  const outputPattern = path.join(streamDir, '%s.mp4');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-rtsp_transport',
    'tcp',
    '-i',
    streamUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-segment_format_options',
    'movflags=+faststart',
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    outputPattern
  ];
  let child = null;
  let restartTimer = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const launch = () => {
    if (stopping) {
      return;
    }

    child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'inherit']
    });
    console.error(`recording ${role} stream ${streamName} from ${streamUrl}`);

    child.on('exit', (exitCode, signal) => {
      child = null;
      if (stopping) {
        resolveStopped();
        return;
      }

      console.error(
        `ffmpeg recorder for ${streamName} exited with code ${exitCode ?? 'null'} signal ${signal ?? 'null'}; restarting in ${restartDelayMs} ms`
      );
      restartTimer = setTimeout(launch, restartDelayMs);
    });
  };

  launch();

  return {
    stop(signal) {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!child) {
        resolveStopped();
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

function startRecordingObserver({ camera, role, streamName }) {
  const streamDir = path.join(recordingsDir, streamName);
  const pending = new Map();
  const observedThisRun = new Set();
  const watcher = watch(streamDir, (eventType, fileName) => {
    if (stopping || !fileName) {
      return;
    }
    const entry = fileName.toString();
    if (segmentStartMs(entry) === null) {
      return;
    }
    scheduleObservation(entry, segmentSettleMs);
  });
  watcher.on('error', (error) => {
    console.error(`recording observer failed for ${streamName}:`, error);
  });

  function scheduleObservation(entry, delayMs) {
    const existing = pending.get(entry);
    if (existing) {
      clearTimeout(existing);
    }
    pending.set(entry, setTimeout(() => {
      pending.delete(entry);
      void observe(entry).catch((error) => {
        console.error(`recording observation failed for ${streamName}/${entry}:`, error);
      });
    }, Math.max(100, delayMs)));
  }

  async function observe(entry) {
    if (stopping) {
      return;
    }
    const startMs = segmentStartMs(entry);
    if (startMs === null) {
      return;
    }
    const relativePath = path.join(streamName, entry);
    if (observedThisRun.has(relativePath) || catalog.hasSegment(relativePath)) {
      observedThisRun.add(relativePath);
      return;
    }

    const absolutePath = path.join(streamDir, entry);
    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      return;
    }
    const remainingSettleMs = segmentSettleMs - (Date.now() - stats.mtimeMs);
    if (remainingSettleMs > 0) {
      scheduleObservation(entry, remainingSettleMs);
      return;
    }
    if (stats.size < minimumSegmentBytes) {
      return;
    }

    const segment = {
      cameraId: camera.id,
      role,
      streamName,
      startMs,
      durationMs: segmentSeconds * 1000,
      sizeBytes: stats.size,
      relativePath,
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
    observedThisRun.add(relativePath);
  }

  return {
    close() {
      watcher.close();
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    }
  };
}

async function sweepRetentionIfIdle() {
  if (!retentionEnabled || retentionSweepInFlight || stopping) {
    return;
  }
  retentionSweepInFlight = true;
  try {
    const nowMs = Date.now();
    const expired = catalog.segmentsPastRetention(nowMs - mainRetentionMs, nowMs - subRetentionMs);
    for (const segment of expired) {
      if (stopping) {
        return;
      }
      const absolutePath = path.join(recordingsDir, segment.relativePath);
      try {
        await unlink(absolutePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
      catalog.expireSegment(segment.relativePath, nowMs);
      await appendCameraEvent({
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
            : Math.round(subRetentionMs / (24 * 60 * 60 * 1000))
        }
      });
    }
  } catch (error) {
    console.error('recording retention sweep failed:', error);
  } finally {
    retentionSweepInFlight = false;
  }
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

function segmentStartMs(fileName) {
  const match = fileName.match(/^(\d+)\.mp4$/);
  return match ? Number(match[1]) * 1000 : null;
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
  for (const observer of observers) {
    observer.close();
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
