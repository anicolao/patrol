import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  appendCameraEvent,
  appendProcessExited,
  startProcessHeartbeats
} from './lib/patrol-events.mjs';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const eventsDir = path.join(dataRoot, 'events');
const secretsDir = path.join(dataRoot, 'secrets');
const recordingsDir = path.join(dataRoot, 'recordings');
const go2rtcRtspBaseUrl = process.env.PATROL_GO2RTC_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554';
const segmentSeconds = Number(process.env.PATROL_RECORDING_SEGMENT_SECONDS ?? '15');
const scanEveryMs = Number(process.env.PATROL_RECORDING_SCAN_MS ?? '10000');
const restartDelayMs = Number(process.env.PATROL_RECORDING_RESTART_DELAY_MS ?? '5000');
const mainRetentionMs = Number(process.env.PATROL_MAIN_RECORDING_RETENTION_DAYS ?? '7') * 24 * 60 * 60 * 1000;
const subRetentionMs = Number(process.env.PATROL_SUB_RECORDING_RETENTION_DAYS ?? '30') * 24 * 60 * 60 * 1000;
const segmentSettleMs = Number(process.env.PATROL_RECORDING_SEGMENT_SETTLE_MS ?? '5000');
const minimumSegmentBytes = Number(process.env.PATROL_RECORDING_MIN_SEGMENT_BYTES ?? String(256 * 1024));
const recordingRoles = parseRecordingRoles(process.env.PATROL_RECORDING_ROLES ?? 'main,sub');

await mkdir(recordingsDir, { recursive: true, mode: 0o700 });

const cameras = await configuredCameras();
const observedPaths = new Set(
  (await readJsonlDir(eventsDir, 'cameras-'))
    .filter((event) => event.type === 'recording.segment.observed')
    .map((event) => event.payload.relativePath)
);
const expiredPaths = new Set(
  (await readJsonlDir(eventsDir, 'cameras-'))
    .filter((event) => event.type === 'recording.segment.expired')
    .map((event) => event.payload.relativePath)
);
let stopping = false;

const heartbeat = startProcessHeartbeats({
  processId: 'patrol-recorder',
  label: 'Recording worker',
  kind: 'worker',
  detail: `Recording ${recordingRoles.join('+')} for ${cameras.length} configured camera${cameras.length === 1 ? '' : 's'}`
});

const children = cameras.flatMap((camera) =>
  recordingRoles.map((role) => startRecorder(camera, role, camera.streams[role]))
);

await scanRecordings(cameras);
const scanInterval = setInterval(() => {
  void scanRecordings(cameras).catch((error) => {
    console.error('recording scan failed:', error);
  });
}, scanEveryMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) {
      child.stop(signal);
    }
    shutdown(128 + signalNumber(signal), signal);
  });
}

if (children.length === 0) {
  console.error('patrol-recorder found no configured cameras; staying alive for health visibility');
}

function startRecorder(camera, role, streamName) {
  const streamDir = path.join(recordingsDir, streamName);
  void mkdir(streamDir, { recursive: true, mode: 0o700 });
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
      }
      child?.kill(signal);
    }
  };
}

async function scanRecordings(cameras) {
  const nowMs = Date.now();
  for (const camera of cameras) {
    for (const role of recordingRoles) {
      const streamName = camera.streams[role];
      const streamDir = path.join(recordingsDir, streamName);
      let entries;
      try {
        entries = await readdir(streamDir);
      } catch {
        continue;
      }

      for (const entry of entries.filter((fileName) => fileName.endsWith('.mp4'))) {
        const absolutePath = path.join(streamDir, entry);
        const relativePath = path.join(streamName, entry);
        const startMs = segmentStartMs(entry);
        if (startMs === null) {
          continue;
        }

        const stats = await stat(absolutePath);
        const retentionMs = role === 'main' ? mainRetentionMs : subRetentionMs;
        if (nowMs - startMs > retentionMs) {
          await expireSegment({
            camera,
            role,
            streamName,
            startMs,
            relativePath,
            absolutePath,
            retentionDays: Math.round(retentionMs / (24 * 60 * 60 * 1000))
          });
          continue;
        }

        if (stats.size < minimumSegmentBytes) {
          continue;
        }

        if (
          nowMs - stats.mtimeMs < segmentSettleMs ||
          observedPaths.has(relativePath) ||
          expiredPaths.has(relativePath)
        ) {
          continue;
        }

        await appendCameraEvent({
          type: 'recording.segment.observed',
          source: 'patrol-recorder',
          payload: {
            cameraId: camera.id,
            role,
            streamName,
            startMs,
            durationMs: segmentSeconds * 1000,
            sizeBytes: stats.size,
            relativePath
          }
        });
        observedPaths.add(relativePath);
      }
    }
  }
}

function parseRecordingRoles(value) {
  const roles = value
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const validRoles = roles.filter((role) => role === 'main' || role === 'sub');
  return validRoles.length > 0 ? Array.from(new Set(validRoles)) : ['main', 'sub'];
}

async function expireSegment(input) {
  if (expiredPaths.has(input.relativePath)) {
    return;
  }

  try {
    await unlink(input.absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await appendCameraEvent({
    type: 'recording.segment.expired',
    source: 'patrol-recorder',
    payload: {
      cameraId: input.camera.id,
      role: input.role,
      streamName: input.streamName,
      startMs: input.startMs,
      relativePath: input.relativePath,
      retentionDays: input.retentionDays
    }
  });
  expiredPaths.add(input.relativePath);
  observedPaths.delete(input.relativePath);
}

async function configuredCameras() {
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

function shutdown(exitCode, signal) {
  clearInterval(heartbeat);
  clearInterval(scanInterval);
  void appendProcessExited({
    processId: 'patrol-recorder',
    label: 'Recording worker',
    kind: 'worker',
    exitCode,
    signal,
    detail: 'Recording worker stopped'
  }).finally(() => {
    process.exit(exitCode);
  });
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
