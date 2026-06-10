import { json } from '@sveltejs/kit';
import { appendCameraCredentials } from '$lib/server/secrets';

export async function POST({ request }) {
  const body = await request.json();
  const cameraId = stringField(body, 'cameraId');
  const host = stringField(body, 'host');
  const username = stringField(body, 'username');
  const password = stringField(body, 'password');

  if (!cameraId || !host || !username || !password) {
    return json({ error: 'cameraId, host, username, and password are required.' }, { status: 400 });
  }

  const stored = await appendCameraCredentials({
    cameraId,
    host,
    username,
    password
  });

  return json(stored);
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || !(field in value)) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue.trim() : null;
}
