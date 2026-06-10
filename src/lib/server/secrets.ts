import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
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

export interface ResolvedCameraCredentials {
  cameraId: string;
  host: string;
  username: string;
  password: string;
  storedAtMs: number;
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

export async function readLatestCameraCredentials(
  cameraId: string
): Promise<ResolvedCameraCredentials | null> {
  const secretsDir = await ensureSecretsDir();
  let entries: string[];
  try {
    entries = await readdir(secretsDir);
  } catch {
    return null;
  }

  const matchingEvents: SecretEvent[] = [];
  for (const entry of entries.filter((fileName) => fileName.startsWith('secrets-')).sort()) {
    const content = await readFile(path.join(secretsDir, entry), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line) as SecretEvent;
      if (event.type === 'secret.camera.credentials.set' && event.camera_id === cameraId) {
        matchingEvents.push(event);
      }
    }
  }

  const latest = matchingEvents.sort((a, b) => b.ts_ms - a.ts_ms || b.id.localeCompare(a.id))[0];
  if (!latest) {
    return null;
  }

  return {
    cameraId,
    host: latest.payload.host,
    username: latest.payload.username,
    password: latest.payload.password,
    storedAtMs: latest.ts_ms
  };
}

async function secretsFilePath(tsMs: number) {
  const secretsDir = await ensureSecretsDir();
  const day = new Date(tsMs).toISOString().slice(0, 10);
  return path.join(secretsDir, `secrets-${day}.jsonl`);
}

async function ensureSecretsDir() {
  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  const secretsDir = path.join(root, 'secrets');
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  return secretsDir;
}
