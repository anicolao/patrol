import { homedir } from 'node:os';
import path from 'node:path';

const RECORDING_SEGMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d+)\.mp4$/;

export function patrolThumbnailDir() {
  return process.env.PATROL_THUMBNAIL_DIR ?? path.join(homedir(), '.cache', 'patrol', 'recording-thumbnails');
}

export function thumbnailRelativePath(recordingRelativePath: string) {
  const match = RECORDING_SEGMENT_PATTERN.exec(recordingRelativePath);
  if (!match) {
    throw new Error('Invalid recording segment path.');
  }

  const [, streamName, startSecondsText] = match;
  const startSeconds = Number(startSecondsText);
  const startDate = new Date(startSeconds * 1000);
  if (!Number.isSafeInteger(startSeconds) || Number.isNaN(startDate.getTime())) {
    throw new Error('Invalid recording segment timestamp.');
  }

  return path.join(
    streamName,
    String(startDate.getUTCFullYear()).padStart(4, '0'),
    String(startDate.getUTCMonth() + 1).padStart(2, '0'),
    String(startDate.getUTCDate()).padStart(2, '0'),
    String(startDate.getUTCHours()).padStart(2, '0'),
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
