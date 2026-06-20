import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { error } from '@sveltejs/kit';
import { stat } from 'node:fs/promises';
import { patrolRecordingsDir } from '$lib/server/paths';

const execFileAsync = promisify(execFile);

export async function GET({ url }) {
  const relativePath = url.searchParams.get('path');
  if (!relativePath) {
    error(400, 'Missing recording path.');
  }

  const offsetSeconds = Number(url.searchParams.get('t') ?? '0');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
    error(400, 'Invalid thumbnail offset.');
  }

  const recordingsDir = patrolRecordingsDir();
  const absolutePath = path.resolve(recordingsDir, relativePath);
  const resolvedRoot = path.resolve(recordingsDir);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    error(400, 'Recording path escapes the recordings directory.');
  }

  try {
    await stat(absolutePath);
  } catch {
    error(404, 'Recording segment not found.');
  }

  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(Math.max(0, offsetSeconds)),
        '-i',
        absolutePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=180:-1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024,
        timeout: 5000
      }
    );

    return new Response(stdout, {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(stdout.length),
        'cache-control': 'private, max-age=3600'
      }
    });
  } catch {
    error(404, 'Unable to extract recording thumbnail.');
  }
}
