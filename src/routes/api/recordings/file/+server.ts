import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export async function GET({ request, url }) {
  const relativePath = url.searchParams.get('path');
  if (!relativePath) {
    error(400, 'Missing recording path.');
  }

  const recordingsDir = path.join(process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol'), 'recordings');
  const absolutePath = path.resolve(recordingsDir, relativePath);
  const resolvedRoot = path.resolve(recordingsDir);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    error(400, 'Recording path escapes the recordings directory.');
  }

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    error(404, 'Recording segment not found.');
  }

  const range = request.headers.get('range');
  const byteRange = range ? parseRange(range, stats.size) : null;
  if (range && !byteRange) {
    return new Response(null, {
      status: 416,
      headers: {
        'content-range': `bytes */${stats.size}`
      }
    });
  }

  if (byteRange) {
    return new Response(
      Readable.toWeb(createReadStream(absolutePath, { start: byteRange.start, end: byteRange.end })) as ReadableStream,
      {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(byteRange.end - byteRange.start + 1),
          'content-range': `bytes ${byteRange.start}-${byteRange.end}/${stats.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=60'
        }
      }
    );
  }

  return new Response(Readable.toWeb(createReadStream(absolutePath)) as ReadableStream, {
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(stats.size),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=60'
    }
  });
}

function parseRange(range: string, size: number) {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}
