import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export async function GET({ url }) {
  const relativePath = url.searchParams.get('path');
  if (!relativePath) {
    error(400, 'Missing person crop path.');
  }

  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  const cropsDir = path.resolve(root, 'person-recognition', 'crops');
  const absolutePath = path.resolve(cropsDir, relativePath);
  if (!absolutePath.startsWith(`${cropsDir}${path.sep}`)) {
    error(400, 'Person crop path escapes the crop directory.');
  }

  try {
    await stat(absolutePath);
  } catch {
    error(404, 'Person crop not found.');
  }

  return new Response(Readable.toWeb(createReadStream(absolutePath)) as ReadableStream, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=300'
    }
  });
}
