import { homedir } from 'node:os';
import path from 'node:path';

const LEGACY_RECORDING_SEGMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d+)\.(?:mp4|m4v)$/;
const HIERARCHICAL_RECORDING_SEGMENT_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d+)\.(?:mp4|m4v)$/;

export function patrolThumbnailDir() {
  return process.env.PATROL_THUMBNAIL_DIR ?? path.join(homedir(), '.cache', 'patrol', 'recording-thumbnails');
}

export function thumbnailRelativePath(recordingRelativePath: string) {
  const legacy = LEGACY_RECORDING_SEGMENT_PATTERN.exec(recordingRelativePath);
  const hierarchical = HIERARCHICAL_RECORDING_SEGMENT_PATTERN.exec(recordingRelativePath);
  const match = legacy ?? hierarchical;
  if (!match) {
    throw new Error('Invalid recording segment path.');
  }

  const streamName = match[1];
  const startSecondsText = legacy ? match[2] : match[6];
  const timestamp = Number(startSecondsText);
  const startMs = timestamp >= 100_000_000_000 ? timestamp : timestamp * 1000;
  const startDate = new Date(startMs);
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(startDate.getTime())) {
    throw new Error('Invalid recording segment timestamp.');
  }

  const year = String(startDate.getUTCFullYear()).padStart(4, '0');
  const month = String(startDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(startDate.getUTCDate()).padStart(2, '0');
  const hour = String(startDate.getUTCHours()).padStart(2, '0');
  if (hierarchical && [match[2], match[3], match[4], match[5]].join('/') !== [year, month, day, hour].join('/')) {
    throw new Error('Recording segment path does not match its timestamp.');
  }

  return path.join(
    streamName,
    year,
    month,
    day,
    hour,
    `${startSecondsText}.jpg`
  );
}

export function thumbnailAbsolutePath(thumbnailRoot: string, recordingRelativePath: string) {
  return resolveThumbnailPath(thumbnailRoot, thumbnailRelativePath(recordingRelativePath));
}

export function resolveThumbnailPath(thumbnailRoot: string, relativePath: string) {
  const resolvedRoot = path.resolve(thumbnailRoot);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Thumbnail path escapes the thumbnail directory.');
  }
  return absolutePath;
}
