import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { openRecordingCatalog } from '../src/lib/server/recording-catalog.ts';
import {
  patrolThumbnailDir,
  resolveThumbnailPath,
  thumbnailAbsolutePath,
  thumbnailRelativePath
} from '../src/lib/server/recording-thumbnails.ts';
import { appendProcessExited, startProcessHeartbeats } from './lib/patrol-events.mjs';
import { patrolDataRoot, patrolRecordingsDir } from './lib/patrol-paths.mjs';

const execFileAsync = promisify(execFile);
const processId = 'patrol-thumbnailer';
const label = 'Recording thumbnail worker';
const kind = 'worker';
const dataRoot = patrolDataRoot();
const recordingsDir = patrolRecordingsDir(dataRoot);
const thumbnailRoot = patrolThumbnailDir();
const retentionMs = positiveNumber('PATROL_THUMBNAIL_RETENTION_MS', 7 * 24 * 60 * 60 * 1000);
const pollMs = positiveNumber('PATROL_THUMBNAILER_POLL_MS', 2000);
const retryMs = positiveNumber('PATROL_THUMBNAILER_RETRY_MS', 5 * 60 * 1000);
const commandTimeoutMs = positiveNumber('PATROL_THUMBNAILER_COMMAND_TIMEOUT_MS', 15000);
const batchSize = Math.floor(positiveNumber('PATROL_THUMBNAILER_BATCH_SIZE', 25));
const once = process.env.PATROL_THUMBNAILER_ONCE === '1';

let stopping = false;
let shutdownStarted = false;
const thumbnailDirectoryExisted = await exists(thumbnailRoot);
const catalog = await openRecordingCatalog(dataRoot);
if (!thumbnailDirectoryExisted) {
  catalog.resetGeneratedThumbnails();
}
await mkdir(thumbnailRoot, { recursive: true, mode: 0o700 });

const heartbeat = startProcessHeartbeats({
  processId,
  label,
  kind,
  detail: 'Precomputes local JPEG previews for main recording segments'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    void shutdown(128 + signalNumber(signal), signal);
  });
}

try {
  do {
    const generated = await generateBatch();
    const cleaned = await cleanupBatch();
    if (!once && !stopping && generated === 0 && cleaned === 0) {
      await sleep(pollMs);
    }
  } while (!once && !stopping);
} catch (error) {
  console.error('recording thumbnail worker failed:', error);
  await shutdown(1, null);
}

if (once) {
  clearInterval(heartbeat);
  catalog.close();
}

async function generateBatch() {
  const nowMs = Date.now();
  const candidates = catalog.segmentsNeedingThumbnails(nowMs - retentionMs, nowMs, batchSize);
  for (const candidate of candidates) {
    if (stopping) {
      break;
    }

    try {
      const result = await generateThumbnail(candidate.relativePath);
      catalog.markThumbnailGenerated(
        candidate.relativePath,
        result.thumbnailRelativePath,
        result.sizeBytes,
        Date.now()
      );
      console.log(JSON.stringify({ event: 'recording.thumbnail.generated', ...candidate, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      catalog.markThumbnailFailed(candidate.relativePath, message, Date.now() + retryMs);
      console.error(JSON.stringify({
        event: 'recording.thumbnail.failed',
        relativePath: candidate.relativePath,
        error: message
      }));
    }
  }
  return candidates.length;
}

async function generateThumbnail(relativePath) {
  const thumbnailRelative = thumbnailRelativePath(relativePath);
  const destination = thumbnailAbsolutePath(thumbnailRoot, relativePath);
  const source = resolveRecordingPath(relativePath);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.jpg`;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '1',
        '-i',
        source,
        '-frames:v',
        '1',
        '-vf',
        'scale=180:-2',
        '-q:v',
        '5',
        '-y',
        temporary
      ],
      { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024 }
    );
    const outputStat = await stat(temporary);
    if (outputStat.size === 0) {
      throw new Error('ffmpeg produced an empty thumbnail.');
    }
    await rename(temporary, destination);
    return { thumbnailRelativePath: thumbnailRelative, sizeBytes: outputStat.size };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function cleanupBatch() {
  const records = catalog.thumbnailRecordsPastRetention(Date.now() - retentionMs, batchSize);
  for (const record of records) {
    if (record.thumbnailRelativePath) {
      const absolutePath = resolveThumbnailPath(thumbnailRoot, record.thumbnailRelativePath);
      try {
        await unlink(absolutePath);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }
    catalog.deleteThumbnail(record.relativePath);
  }
  return records.length;
}

function resolveRecordingPath(relativePath) {
  // The thumbnail mapper validates the exact stream/timestamp segment shape.
  thumbnailRelativePath(relativePath);
  const resolvedRoot = path.resolve(recordingsDir);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Recording path escapes the recordings directory.');
  }
  return absolutePath;
}

async function shutdown(exitCode, signal) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  clearInterval(heartbeat);
  await appendProcessExited({
    processId,
    label,
    kind,
    exitCode,
    signal,
    detail: exitCode === 0 ? 'Recording thumbnail worker stopped' : 'Recording thumbnail worker exited'
  }).catch((error) => {
    console.error('failed to append thumbnail worker exit:', error);
  });
  catalog.close();
  process.exit(exitCode === 1 ? 1 : 0);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function positiveNumber(name, fallback) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalNumber(signal) {
  return signal === 'SIGINT' ? 2 : 15;
}
