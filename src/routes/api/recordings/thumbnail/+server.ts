import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { patrolThumbnailDir, thumbnailAbsolutePath } from '$lib/server/recording-thumbnails';

export async function GET({ url }) {
  const relativePath = url.searchParams.get('path');
  if (!relativePath) {
    error(400, 'Missing recording path.');
  }

  let absolutePath: string;
  try {
    absolutePath = thumbnailAbsolutePath(patrolThumbnailDir(), relativePath);
  } catch {
    error(400, 'Invalid recording path.');
  }

  let thumbnail: Buffer;
  try {
    thumbnail = await readFile(absolutePath);
  } catch {
    error(404, 'Recording thumbnail not found.');
  }

  const responseBody = new Uint8Array(thumbnail.byteLength);
  responseBody.set(thumbnail);
  return new Response(responseBody, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(thumbnail.length),
      'cache-control': 'private, max-age=31536000, immutable'
    }
  });
}
