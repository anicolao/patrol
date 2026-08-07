import { spawn } from 'node:child_process';
import { link, mkdir, opendir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const STREAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_SEGMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d+)\.(mp4|m4v)$/;
const HIERARCHICAL_SEGMENT_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d+)\.(mp4|m4v)$/;

export function recordingRelativePath(streamName, startMs, extension = 'm4v') {
  requireStreamName(streamName);
  const timestampMs = Math.round(startMs);
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error('Invalid recording segment timestamp.');
  }
  if (extension !== 'm4v' && extension !== 'mp4') {
    throw new Error('Invalid recording segment extension.');
  }

  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid recording segment timestamp.');
  }
  return path.join(
    streamName,
    fourDigits(date.getUTCFullYear()),
    twoDigits(date.getUTCMonth() + 1),
    twoDigits(date.getUTCDate()),
    twoDigits(date.getUTCHours()),
    `${timestampMs}.${extension}`
  );
}

export function parseRecordingRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const legacy = LEGACY_SEGMENT_PATTERN.exec(normalized);
  if (legacy) {
    const [, streamName, startSecondsText, extension] = legacy;
    return parsedSegment(streamName, startSecondsText, extension, true, normalized);
  }

  const hierarchical = HIERARCHICAL_SEGMENT_PATTERN.exec(normalized);
  if (!hierarchical) {
    return null;
  }
  const [, streamName, year, month, day, hour, startSecondsText, extension] = hierarchical;
  const parsed = parsedSegment(streamName, startSecondsText, extension, false, normalized);
  if (!parsed) {
    return null;
  }
  const canonical = recordingRelativePath(streamName, parsed.startMs, extension).split(path.sep).join('/');
  if (canonical !== normalized) {
    return null;
  }
  if (!canonical.includes(`/${year}/${month}/${day}/${hour}/`)) {
    return null;
  }
  return parsed;
}

export function ffmpegRecordingPattern(recordingsDir, streamName, launchId) {
  requireStreamName(streamName);
  if (!/^[A-Za-z0-9._-]+$/.test(launchId)) {
    throw new Error('Invalid recorder launch identifier.');
  }
  return path.join(recordingsDir, '.staging', streamName, `${launchId}-%09d.m4v`);
}

export function parseFfmpegCompletedSegment(line) {
  const match = /^"?(?:[^",]*[\\/])?([^"\\/,]+\.m4v)"?,([0-9.]+),([0-9.]+)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const mediaStartMs = Number(match[2]) * 1000;
  const mediaEndMs = Number(match[3]) * 1000;
  if (![mediaStartMs, mediaEndMs].every(Number.isFinite)) {
    return null;
  }
  return { fileName: match[1], mediaDurationMs: Math.max(0, Math.round(mediaEndMs - mediaStartMs)) };
}

export async function finalizeStagedRecording(recordingsDir, streamName, stagingPath, preferredStartMs) {
  for (let offsetMs = 0; offsetMs < 1000; offsetMs += 1) {
    const startMs = Math.round(preferredStartMs) + offsetMs;
    const relativePath = recordingRelativePath(streamName, startMs);
    const destinationPath = path.join(recordingsDir, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    try {
      await link(stagingPath, destinationPath);
      try {
        await unlink(stagingPath);
      } catch (error) {
        await unlink(destinationPath).catch(() => {});
        throw error;
      }
      return { relativePath, startMs };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique timestamp for ${stagingPath}.`);
}

export async function waitForStableRecording(filePath, options = {}) {
  const pollMs = options.pollMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const stablePolls = options.stablePolls ?? 2;
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let matchingPolls = 0;

  while (Date.now() <= deadline) {
    const current = await stat(filePath);
    const signature = `${current.size}:${current.mtimeMs}`;
    if (signature === previous) {
      matchingPolls += 1;
      if (matchingPolls >= stablePolls) {
        return current;
      }
    } else {
      previous = signature;
      matchingPolls = 0;
    }
    await delay(pollMs);
  }

  throw new Error(`Recording did not settle within ${timeoutMs} ms: ${filePath}`);
}

export async function probeRecordingFile(filePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const child = spawn(
    options.ffprobePath ?? 'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size',
      '-of',
      'json',
      filePath
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (exitCode) => resolve({ exitCode }));
  });
  clearTimeout(timeout);
  if (outcome.error) {
    throw new Error(`Could not start ffprobe for ${filePath}: ${outcome.error.message}`);
  }
  const exitCode = outcome.exitCode;
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${stderr.trim() || `exit ${exitCode}`}`);
  }

  const result = JSON.parse(stdout);
  const durationSeconds = Number(result?.format?.duration);
  const sizeBytes = Number(result?.format?.size);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe returned an invalid duration for ${filePath}.`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`ffprobe returned an invalid size for ${filePath}.`);
  }
  return {
    durationMs: Math.max(1, Math.round(durationSeconds * 1000)),
    sizeBytes
  };
}

export async function* walkRecordingFiles(recordingsDir, streamNames) {
  for (const streamName of streamNames) {
    requireStreamName(streamName);
    yield* walkDirectory(recordingsDir, path.join(recordingsDir, streamName));
  }
}

export async function migrateLegacyRecording(recordingsDir, relativePath) {
  const parsed = parseRecordingRelativePath(relativePath);
  if (!parsed?.legacy) {
    return relativePath;
  }
  const destinationRelativePath = recordingRelativePath(parsed.streamName, parsed.startMs);
  const sourcePath = path.join(recordingsDir, relativePath);
  const destinationPath = path.join(recordingsDir, destinationRelativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  try {
    await link(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing recording: ${destinationPath}`);
    }
    throw error;
  }
  try {
    await unlink(sourcePath);
  } catch (error) {
    await unlink(destinationPath).catch(() => {});
    throw error;
  }
  return destinationRelativePath;
}

async function* walkDirectory(recordingsDir, directory) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for await (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(recordingsDir, absolutePath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = path.relative(recordingsDir, absolutePath);
    const parsed = parseRecordingRelativePath(relativePath);
    if (parsed) {
      yield { ...parsed, relativePath };
    }
  }
}

function parsedSegment(streamName, startSecondsText, extension, legacy, relativePath) {
  const timestamp = Number(startSecondsText);
  const startMs = timestamp >= 100_000_000_000 ? timestamp : timestamp * 1000;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Number.isNaN(new Date(startMs).getTime())) {
    return null;
  }
  return { streamName, startMs, extension, legacy, relativePath };
}

function requireStreamName(streamName) {
  if (!STREAM_NAME_PATTERN.test(streamName)) {
    throw new Error('Invalid recording stream name.');
  }
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function fourDigits(value) {
  return String(value).padStart(4, '0');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
