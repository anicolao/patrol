import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appendCameraEvent } from './lib/patrol-events.mjs';
import { patrolDataRoot, patrolRecordingsDir } from './lib/patrol-paths.mjs';
import {
  migrateLegacyRecording,
  parseRecordingRelativePath,
  probeRecordingFile,
  recordingRelativePath,
  walkRecordingFiles
} from './lib/recording-files.mjs';
import {
  openRecordingCatalog,
  syncRecordingCatalogFromEvents
} from '../src/lib/server/recording-catalog.ts';

const dataRoot = patrolDataRoot();
const recordingsDir = patrolRecordingsDir(dataRoot);
const concurrency = Math.max(1, Number(process.env.PATROL_RECORDING_BACKFILL_CONCURRENCY ?? '4'));
const migrateLegacy = !['0', 'false', 'no', 'off'].includes(
  String(process.env.PATROL_RECORDING_BACKFILL_MIGRATE ?? 'true').toLowerCase()
);
const dryRun = process.env.PATROL_RECORDING_BACKFILL_DRY_RUN === '1';
const streams = await configuredStreams();
const streamByName = new Map(streams.map((stream) => [stream.streamName, stream]));
const claimedSegments = new Set();
const catalog = await openRecordingCatalog(dataRoot);
const counters = {
  scanned: 0,
  indexed: 0,
  relocated: 0,
  skipped: 0,
  failed: 0
};

try {
  await syncRecordingCatalogFromEvents(catalog, path.join(dataRoot, 'events'));
  const iterator = walkRecordingFiles(recordingsDir, Array.from(streamByName.keys()))[Symbol.asyncIterator]();
  await Promise.all(Array.from({ length: concurrency }, () => runWorker(iterator)));
  console.log(JSON.stringify({ event: 'recording.backfill.completed', dryRun, migrateLegacy, ...counters }));
} finally {
  catalog.close();
}

async function runWorker(iterator) {
  while (true) {
    const { value: file, done } = await iterator.next();
    if (done) {
      return;
    }
    counters.scanned += 1;
    const segmentKey = `${file.streamName}:${file.startMs}`;
    if (claimedSegments.has(segmentKey)) {
      counters.skipped += 1;
      continue;
    }
    claimedSegments.add(segmentKey);
    try {
      await backfillFile(file);
    } catch (error) {
      counters.failed += 1;
      console.error(`recording backfill failed for ${file.relativePath}:`, error);
    }
    if (counters.scanned % 1000 === 0) {
      console.log(JSON.stringify({ event: 'recording.backfill.progress', ...counters }));
    }
  }
}

async function backfillFile(file) {
  const stream = streamByName.get(file.streamName);
  if (!stream) {
    counters.skipped += 1;
    return;
  }

  let relativePath = file.relativePath;
  let previousRelativePath = legacyCatalogPath(file);
  const targetRelativePath = file.legacy && migrateLegacy
    ? hierarchicalPathFor(file)
    : relativePath;

  if (catalog.hasSegment(targetRelativePath) && !previousRelativePath) {
    counters.skipped += 1;
    return;
  }
  if (dryRun) {
    if (relativePath !== targetRelativePath) {
      counters.relocated += 1;
    } else {
      counters.indexed += 1;
    }
    return;
  }

  const media = await probeRecordingFile(path.join(recordingsDir, relativePath));
  if (file.legacy && migrateLegacy) {
    relativePath = await migrateLegacyRecording(recordingsDir, relativePath);
    previousRelativePath ??= file.relativePath;
  }
  const existing = previousRelativePath ? catalog.segmentForPath(previousRelativePath) : null;
  const segment = {
    cameraId: existing?.cameraId ?? stream.cameraId,
    role: existing?.role ?? stream.role,
    streamName: file.streamName,
    startMs: file.startMs,
    durationMs: media.durationMs,
    sizeBytes: media.sizeBytes,
    relativePath,
    observedAtMs: Date.now()
  };

  if (previousRelativePath && previousRelativePath !== relativePath) {
    await appendCameraEvent({
      type: 'recording.segment.relocated',
      source: 'patrol-recording-backfill',
      payload: {
        ...segment,
        previousRelativePath,
        previousSizeBytes: existing?.sizeBytes ?? 0
      }
    });
    catalog.relocateSegment(previousRelativePath, segment);
    counters.relocated += 1;
    return;
  }

  await appendCameraEvent({
    type: 'recording.segment.observed',
    source: 'patrol-recording-backfill',
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
  counters.indexed += 1;
}

function legacyCatalogPath(file) {
  if (file.legacy) {
    return catalog.hasSegment(file.relativePath) ? file.relativePath : null;
  }
  const startSeconds = Math.floor(file.startMs / 1000);
  for (const extension of ['mp4', 'm4v']) {
    const candidate = path.join(file.streamName, `${startSeconds}.${extension}`);
    if (catalog.hasSegment(candidate)) {
      return candidate;
    }
  }
  return null;
}

function hierarchicalPathFor(file) {
  const parsed = parseRecordingRelativePath(file.relativePath);
  return recordingRelativePath(parsed.streamName, parsed.startMs);
}

async function configuredStreams() {
  const checkpointPath = path.join(dataRoot, 'cache', 'server-camera-state.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const devices = checkpoint?.state?.devices;
  if (!Array.isArray(devices)) {
    throw new Error(`No configured camera checkpoint found at ${checkpointPath}.`);
  }
  return devices
    .filter((camera) => camera?.id && camera?.credentials && camera?.streams?.main && camera?.streams?.sub)
    .flatMap((camera) => [
      { cameraId: camera.id, role: 'main', streamName: camera.streams.main },
      { cameraId: camera.id, role: 'sub', streamName: camera.streams.sub }
    ]);
}
