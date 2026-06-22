import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendCameraEvent,
  appendProcessExited,
  startProcessHeartbeats
} from './lib/patrol-events.mjs';
import { patrolDataRoot, patrolRecordingsDir } from './lib/patrol-paths.mjs';

const dataRoot = patrolDataRoot();
const eventsDir = path.join(dataRoot, 'events');
const recordingsDir = patrolRecordingsDir(dataRoot);
const recognizerDir = path.join(dataRoot, 'person-recognition');
const cropsDir = path.join(recognizerDir, 'crops');
const framesDir = path.join(recognizerDir, 'frames');
const cacheDir = path.join(dataRoot, 'cache');
const workerStatePath = path.join(cacheDir, 'person-recognizer-state.json');
const serverStatePath = path.join(cacheDir, 'server-camera-state.json');
const binDir = path.join(dataRoot, 'bin');
const helperPath = path.join(binDir, 'patrol-person-featureprint');
const go2rtcRtspBaseUrl = process.env.PATROL_GO2RTC_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554';
const scanEveryMs = Number(process.env.PATROL_PERSON_RECOGNITION_SCAN_MS ?? '5000');
const maxPendingEventAgeMs = Number(process.env.PATROL_PERSON_RECOGNITION_MAX_EVENT_AGE_MS ?? String(10 * 60 * 1000));
const commandTimeoutMs = Number(process.env.PATROL_PERSON_RECOGNITION_COMMAND_TIMEOUT_MS ?? '20000');
const cropMargin = Number(process.env.PATROL_PERSON_RECOGNITION_CROP_MARGIN ?? '0.1');
const cropVersion = 'motion-diff-v3';

await mkdir(cropsDir, { recursive: true, mode: 0o700 });
await mkdir(framesDir, { recursive: true, mode: 0o700 });
await mkdir(cacheDir, { recursive: true, mode: 0o700 });
await mkdir(binDir, { recursive: true, mode: 0o700 });
await ensureFeatureprintHelper();

let stopping = false;
let scanInterval = null;
let scanning = false;
const heartbeat = startProcessHeartbeats({
  processId: 'patrol-person-recognizer',
  label: 'Person recognition worker',
  kind: 'worker',
  detail: 'Extracts person crops and classifies local recognition samples'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    shutdown(128 + signalNumber(signal), signal);
  });
}

await scanOnce();
scanInterval = setInterval(() => {
  void scanOnceIfIdle().catch((error) => {
    console.error('person recognition scan failed:', error);
  });
}, scanEveryMs);

async function scanOnceIfIdle() {
  if (scanning) {
    return;
  }

  scanning = true;
  try {
    await scanOnce();
  } finally {
    scanning = false;
  }
}

async function scanOnce() {
  const workerState = await readWorkerState();
  const tail = await readCameraEventTail(workerState);
  if (tail.initialized) {
    await writeWorkerState(tail.state);
    return;
  }

  const events = tail.events;
  const checkpoint = await readServerStateCheckpoint();
  await acknowledgePersonLabelActions(events);
  const processedSourceEventIds = new Set(
    [
      ...processedSourceEventIdsFromCheckpoint(checkpoint),
      ...processedSourceEventIdsFromEvents(events)
    ]
  );
  const segments = checkpoint.state.recordings.segments
    .filter((segment) => segment.role === 'main')
    .map((segment) => ({
      cameraId: segment.cameraId,
      streamName: segment.streamName,
      startMs: segment.startMs,
      endMs: segment.endMs,
      relativePath: segment.relativePath
    }));
  const mainStreamNames = reduceMainStreamNamesFromCheckpoint(checkpoint);
  const personAlerts = events
    .filter((event) => event.type === 'annke.alert_stream.message_received')
    .filter((event) => isActivePersonAlert(event.payload.rawXml))
    .filter((event) => Date.now() - (event.payload.receivedAtMs ?? event.ts_ms) <= maxPendingEventAgeMs)
    .filter((event) => !processedSourceEventIds.has(event.id))
    .sort((left, right) => left.payload.receivedAtMs - right.payload.receivedAtMs || left.id.localeCompare(right.id));

  for (const event of personAlerts) {
    if (stopping) {
      return;
    }

    await analyzePersonAlert(event, segments, mainStreamNames);
  }

  await writeWorkerState(tail.state);
}

async function acknowledgePersonLabelActions(events) {
  const processedActionEventIds = new Set(
    events
      .filter((event) => event.type === 'person.recognition.suggestions.updated')
      .flatMap((event) => Array.isArray(event.payload?.processedEventIds) ? event.payload.processedEventIds : [])
  );
  const pendingActions = events
    .filter(
      (event) =>
        event.type === 'person.recognition.sample.labeled' ||
        event.type === 'person.recognition.sample.dismissed'
    )
    .filter((event) => !processedActionEventIds.has(event.id))
    .sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));

  if (pendingActions.length === 0) {
    return;
  }

  await appendCameraEvent({
    type: 'person.recognition.suggestions.updated',
    source: 'patrol-person-recognizer',
    payload: {
      processedEventIds: pendingActions.map((event) => event.id),
      sampleIds: Array.from(new Set(pendingActions.map((event) => event.payload.sampleId).filter(Boolean))).sort(),
      updatedAtMs: Date.now()
    }
  });
}

async function analyzePersonAlert(event, segments, mainStreamNames) {
  const occurredAtMs = event.payload.receivedAtMs ?? event.ts_ms;
  const sampleId = `${event.id}-person`;
  const segment = preferredMainSegment(segments, event.payload.cameraId, occurredAtMs);
  const mainStreamName = mainStreamNames.get(event.payload.cameraId) ?? null;

  try {
    const safeSampleId = safeFileName(sampleId);
    const framePath = path.join(framesDir, `${safeSampleId}.jpg`);
    const previousFramePath = path.join(framesDir, `${safeSampleId}-previous.jpg`);
    const cropRelativePath = `${safeSampleId}.jpg`;
    const cropPath = path.join(cropsDir, cropRelativePath);
    const cropBox = targetCropBox(event.payload.rawXml);
    let sourceSegmentRelativePath = null;
    let sourceOffsetMs = null;

    if (segment) {
      const sourcePath = path.join(recordingsDir, segment.relativePath);
      sourceOffsetMs = Math.max(0, occurredAtMs - segment.startMs);
      const previousOffsetMs = Math.max(0, sourceOffsetMs - 2000);
      await extractFrame(sourcePath, previousOffsetMs, previousFramePath);
      await extractFrame(sourcePath, sourceOffsetMs, framePath);
      sourceSegmentRelativePath = segment.relativePath;
    } else if (mainStreamName && Date.now() - occurredAtMs < maxPendingEventAgeMs) {
      await captureLiveFrames(mainStreamName, framePath, cropBox ? null : previousFramePath);
      sourceSegmentRelativePath = `go2rtc:${mainStreamName}`;
      sourceOffsetMs = 0;
    } else {
      const reason = mainStreamName
        ? 'No retained main-stream recording segment overlaps the person event and the event is too old for a live high-resolution capture.'
        : 'No main go2rtc stream is configured for this camera.';
      await appendRecognitionFailure(event, sampleId, occurredAtMs, reason);
      return;
    }

    const featureprint = await runFeatureprint(framePath, cropPath, cropBox, previousFramePath);
    const detectedCropBox = featureprint.cropBox ?? cropBox;
    const sourceKind = segment ? 'recording' : 'go2rtc_live';
    const cropMethod = cropBox ? `camera_xml_${sourceKind}` : `motion_diff_${sourceKind}`;

    await appendCameraEvent({
      type: 'person.recognition.sample.analyzed',
      source: 'patrol-person-recognizer',
      payload: {
        sampleId,
        cameraId: event.payload.cameraId,
        sourceEventId: event.id,
        occurredAtMs,
        sourceSegmentRelativePath,
        sourceOffsetMs,
        cropRelativePath,
        cropBox: detectedCropBox,
        cropMethod,
        cropVersion,
        embedding: {
          model: featureprint.model,
          dimensions: featureprint.dimensions,
          vector: featureprint.vector.map((value) => Number(value.toFixed(6)))
        }
      }
    });
  } catch (error) {
    await appendRecognitionFailure(event, sampleId, occurredAtMs, error instanceof Error ? error.message : String(error));
  }
}

async function appendRecognitionFailure(event, sampleId, occurredAtMs, error) {
  await appendCameraEvent({
    type: 'person.recognition.sample.failed',
    source: 'patrol-person-recognizer',
    payload: {
      sampleId,
      cameraId: event.payload.cameraId,
      sourceEventId: event.id,
      occurredAtMs,
      cropVersion,
      error
    }
  });
}

async function ensureFeatureprintHelper() {
  try {
    await access(helperPath, fsConstants.X_OK);
    return;
  } catch {
    // Compile below.
  }

  const sourcePath = path.join(process.cwd(), 'scripts', 'person-featureprint.swift');
  await runCommand('xcrun', ['swiftc', sourcePath, '-o', helperPath]);
}

async function extractFrame(sourcePath, sourceOffsetMs, outputPath) {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-ss',
    (sourceOffsetMs / 1000).toFixed(3),
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    outputPath
  ]);
}

async function captureLiveFrames(streamName, framePath, previousFramePath) {
  const streamUrl = `${go2rtcRtspBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(streamName)}`;
  if (previousFramePath) {
    await extractLiveFrame(streamUrl, previousFramePath);
    await sleep(1000);
  }
  await extractLiveFrame(streamUrl, framePath);
}

async function extractLiveFrame(streamUrl, outputPath) {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-rtsp_transport',
    'tcp',
    '-i',
    streamUrl,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    outputPath
  ]);
}

async function runFeatureprint(framePath, cropPath, cropBox, previousFramePath) {
  const args = cropBox
    ? [
        framePath,
        cropPath,
        String(cropBox.x),
        String(cropBox.y),
        String(cropBox.width),
        String(cropBox.height)
      ]
    : [framePath, cropPath, 'auto', previousFramePath];
  const result = await runCommand(helperPath, args);
  return JSON.parse(result.stdout);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${commandTimeoutMs} ms`));
    }, commandTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${exitCode ?? 'null'} signal ${signal ?? 'null'}: ${stderr.trim()}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reduceMainStreamNamesFromCheckpoint(checkpoint) {
  const names = new Map();
  for (const device of checkpoint.state.devices ?? []) {
    if (!device.id || !device.streams?.main) {
      continue;
    }
    names.set(device.id, device.streams.main);
  }
  return names;
}

function preferredMainSegment(segments, cameraId, occurredAtMs) {
  return segments.find(
    (segment) =>
      segment.cameraId === cameraId &&
      occurredAtMs >= segment.startMs &&
      occurredAtMs <= segment.endMs
  ) ?? null;
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

async function readWorkerState() {
  try {
    const raw = await readFile(workerStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      cursors: parsed && typeof parsed.cursors === 'object' && parsed.cursors ? parsed.cursors : {}
    };
  } catch {
    return { version: 1, cursors: {} };
  }
}

async function writeWorkerState(state) {
  const tmpPath = `${workerStatePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await rename(tmpPath, workerStatePath);
}

async function readCameraEventTail(workerState) {
  let entries;
  try {
    entries = (await readdir(eventsDir)).filter((fileName) => fileName.startsWith('cameras-')).sort();
  } catch {
    return { events: [], state: workerState, initialized: false };
  }

  const nextState = {
    version: 1,
    cursors: { ...workerState.cursors }
  };
  const isInitialState = Object.keys(workerState.cursors).length === 0;
  const events = [];

  for (const entry of entries) {
    const filePath = path.join(eventsDir, entry);
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      continue;
    }

    if (isInitialState) {
      nextState.cursors[filePath] = stats.size;
      continue;
    }

    const cursor = Number(nextState.cursors[filePath] ?? 0);
    const offset = Number.isFinite(cursor) && cursor >= 0 && cursor <= stats.size ? cursor : 0;
    if (stats.size === offset) {
      nextState.cursors[filePath] = stats.size;
      continue;
    }

    const content = await readFileRange(filePath, offset, stats.size - offset);
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        console.error(`ignored malformed camera event line in ${filePath}:`, error);
      }
    }
    nextState.cursors[filePath] = stats.size;
  }

  pruneOldCursors(nextState, entries);
  events.sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));
  return { events, state: nextState, initialized: isInitialState };
}

async function readFileRange(filePath, position, length) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function pruneOldCursors(state, entries) {
  const retained = new Set(entries.map((entry) => path.join(eventsDir, entry)));
  for (const filePath of Object.keys(state.cursors)) {
    if (!retained.has(filePath)) {
      delete state.cursors[filePath];
    }
  }
}

async function readServerStateCheckpoint() {
  const raw = await readFile(serverStatePath, 'utf8');
  const snapshot = JSON.parse(raw);
  if (!snapshot?.state?.recordings || !Array.isArray(snapshot.state.recordings.segments)) {
    throw new Error(`Invalid server state checkpoint at ${serverStatePath}`);
  }
  return snapshot;
}

function processedSourceEventIdsFromCheckpoint(checkpoint) {
  return (checkpoint.state.people?.samples ?? [])
    .filter((sample) => sample.cropVersion === cropVersion)
    .map((sample) => sample.sourceEventId)
    .filter(Boolean);
}

function processedSourceEventIdsFromEvents(events) {
  return events
    .filter(
      (event) =>
        (event.type === 'person.recognition.sample.failed' && event.payload.cropVersion === cropVersion) ||
        (event.type === 'person.recognition.sample.analyzed' &&
          event.payload.cropVersion === cropVersion &&
          event.payload.cropBox)
    )
    .map((event) => event.payload.sourceEventId)
    .filter(Boolean);
}

function isActivePersonAlert(xml) {
  const state = textForTag(xml, 'eventState');
  const targetType = textForTag(xml, 'targetType')?.toLowerCase();
  const eventDescription = textForTag(xml, 'eventDescription')?.toLowerCase() ?? '';
  return (
    (!state || state === 'active') &&
    (targetType === 'human' || targetType === 'person' || eventDescription.includes('human') || eventDescription.includes('person'))
  );
}

function targetCropBox(xml) {
  const x = firstNumberTag(xml, ['x', 'positionX', 'left', 'beginX']);
  const y = firstNumberTag(xml, ['y', 'positionY', 'top', 'beginY']);
  let width = firstNumberTag(xml, ['width', 'w']);
  let height = firstNumberTag(xml, ['height', 'h']);
  const right = firstNumberTag(xml, ['right', 'endX']);
  const bottom = firstNumberTag(xml, ['bottom', 'endY']);

  if (x === null || y === null) {
    return null;
  }

  if (width === null && right !== null) {
    width = right - x;
  }
  if (height === null && bottom !== null) {
    height = bottom - y;
  }
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  const scale = Math.max(x, y, width, height, right ?? 0, bottom ?? 0) > 100 ? 1000 : Math.max(x, y, width, height) > 1 ? 100 : 1;
  const normalized = {
    x: x / scale,
    y: y / scale,
    width: width / scale,
    height: height / scale
  };

  return expandedCropBox(normalized, cropMargin);
}

function expandedCropBox(box, margin) {
  const x = Math.max(0, box.x - box.width * margin);
  const y = Math.max(0, box.y - box.height * margin);
  const right = Math.min(1, box.x + box.width * (1 + margin));
  const bottom = Math.min(1, box.y + box.height * (1 + margin));
  return {
    x: roundCrop(x),
    y: roundCrop(y),
    width: roundCrop(Math.max(0.01, right - x)),
    height: roundCrop(Math.max(0.01, bottom - y))
  };
}

function firstNumberTag(xml, tags) {
  for (const tag of tags) {
    const rawValue = textForTag(xml, tag);
    if (!rawValue) {
      continue;
    }
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function textForTag(xml, tagName) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function roundCrop(value) {
  return Number(value.toFixed(4));
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function shutdown(exitCode, signal) {
  clearInterval(heartbeat);
  if (scanInterval) {
    clearInterval(scanInterval);
  }
  void appendProcessExited({
    processId: 'patrol-person-recognizer',
    label: 'Person recognition worker',
    kind: 'worker',
    exitCode,
    signal,
    detail: 'Person recognition worker stopped'
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
