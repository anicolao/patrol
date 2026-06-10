import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

interface CameraCredentialInput {
  cameraId: string;
  host: string;
  username: string;
  password: string;
}

interface SecretEvent {
  id: string;
  ts_ms: number;
  type: 'secret.camera.credentials.set';
  source: 'patrol-web';
  schema: 1;
  camera_id: string;
  payload: {
    host: string;
    username_secret_id: string;
    username: string;
    password_secret_id: string;
    password: string;
  };
}

export interface StoredCameraCredentials {
  cameraId: string;
  host: string;
  storedAtMs: number;
  secretIds: {
    username: string;
    password: string;
  };
}

export async function appendCameraCredentials(input: CameraCredentialInput): Promise<StoredCameraCredentials> {
  const storedAtMs = Date.now();
  const secretIds = {
    username: `camera.${input.cameraId}.username`,
    password: `camera.${input.cameraId}.password`
  };
  const event: SecretEvent = {
    id: randomUUID(),
    ts_ms: storedAtMs,
    type: 'secret.camera.credentials.set',
    source: 'patrol-web',
    schema: 1,
    camera_id: input.cameraId,
    payload: {
      host: input.host,
      username_secret_id: secretIds.username,
      username: input.username,
      password_secret_id: secretIds.password,
      password: input.password
    }
  };

  const filePath = await secretsFilePath(storedAtMs);
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
  } finally {
    await handle.close();
  }

  return {
    cameraId: input.cameraId,
    host: input.host,
    storedAtMs,
    secretIds
  };
}

async function secretsFilePath(tsMs: number) {
  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  const secretsDir = path.join(root, 'secrets');
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });

  const day = new Date(tsMs).toISOString().slice(0, 10);
  return path.join(secretsDir, `secrets-${day}.jsonl`);
}
