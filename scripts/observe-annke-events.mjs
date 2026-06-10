import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const eventsDir = path.join(dataRoot, 'events');
const secretsDir = path.join(dataRoot, 'secrets');
const alertStreamPath = '/ISAPI/Event/notification/alertStream';
const capabilityPaths = [
  '/ISAPI/System/deviceInfo',
  '/ISAPI/System/Video/inputs/channels/1/motionDetection',
  '/ISAPI/Smart/capabilities'
];
const durationMs = Number(process.env.PATROL_ANNKE_ALERT_DURATION_MS ?? '0');
const credentials = latestCameraCredentials(await readJsonlDir(secretsDir, 'secrets-'));

if (credentials.length === 0) {
  console.error('No camera credentials found in .patrol/secrets.');
  process.exit(1);
}

await Promise.all(credentials.map((cameraCredentials) => observeCamera(cameraCredentials)));

async function observeCamera(cameraCredentials) {
  await observeCapabilities(cameraCredentials);
  await observeAlertStream(cameraCredentials);
}

async function observeCapabilities(cameraCredentials) {
  for (const isapiPath of capabilityPaths) {
    const startedAtMs = Date.now();
    let statusCode = null;
    let body = null;
    let error = null;
    let ok = false;

    try {
      const response = await digestFetch({
        url: new URL(isapiPath, `http://${cameraCredentials.host}`),
        username: cameraCredentials.username,
        password: cameraCredentials.password,
        timeoutMs: 10_000
      });
      statusCode = response.status;
      body = await response.text();
      ok = response.ok;
      if (!response.ok) {
        error = `Annke ISAPI ${isapiPath} returned HTTP ${response.status}`;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    await appendCameraEvent({
      type: 'annke.isapi.response.observed',
      source: 'patrol-annke-observer',
      payload: {
        cameraId: cameraCredentials.cameraId,
        host: cameraCredentials.host,
        path: isapiPath,
        rawResult: {
          startedAtMs,
          durationMs: Date.now() - startedAtMs,
          ok,
          statusCode,
          body,
          error
        }
      }
    });
  }
}

async function observeAlertStream(cameraCredentials) {
  const controller = new AbortController();
  let timeout = null;
  if (durationMs > 0) {
    timeout = setTimeout(() => controller.abort(), durationMs);
  }

  try {
    const response = await digestFetch({
      url: new URL(alertStreamPath, `http://${cameraCredentials.host}`),
      username: cameraCredentials.username,
      password: cameraCredentials.password,
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Annke alert stream returned HTTP ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = await appendAlertMessages(cameraCredentials, buffer);
      buffer = parsed.remaining;
    }
  } catch (caught) {
    if (!(caught instanceof Error) || caught.name !== 'AbortError') {
      console.error(caught instanceof Error ? caught.message : String(caught));
      process.exitCode = 1;
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function appendAlertMessages(cameraCredentials, buffer) {
  const pattern = /(?:<\?xml[^>]*>\s*)?<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(buffer))) {
    const rawXml = match[0].trim();
    lastIndex = pattern.lastIndex;
    await appendCameraEvent({
      type: 'annke.alert_stream.message_received',
      source: 'patrol-annke-events',
      payload: {
        cameraId: cameraCredentials.cameraId,
        host: cameraCredentials.host,
        sourcePath: alertStreamPath,
        receivedAtMs: Date.now(),
        rawXml
      }
    });
  }
  return { remaining: buffer.slice(lastIndex) };
}

async function digestFetch(input) {
  const method = input.method ?? 'GET';
  const controller = input.signal ? null : new AbortController();
  const signal = input.signal ?? controller.signal;
  const timeout = input.timeoutMs && controller ? setTimeout(() => controller.abort(), input.timeoutMs) : null;

  try {
    const first = await fetch(input.url, { method, signal });
    if (first.status !== 401) {
      return first;
    }

    const challenge = first.headers.get('www-authenticate');
    if (!challenge?.toLowerCase().startsWith('digest ')) {
      return first;
    }

    const digest = parseDigestChallenge(challenge);
    const authorization = digestAuthorization({
      digest,
      method,
      uri: `${input.url.pathname}${input.url.search}`,
      username: input.username,
      password: input.password
    });

    return await fetch(input.url, {
      method,
      headers: { authorization },
      signal
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function digestAuthorization(input) {
  const algorithm = input.digest.algorithm ?? 'MD5';
  if (algorithm.toUpperCase() !== 'MD5') {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }

  const realm = requiredDigestValue(input.digest, 'realm');
  const nonce = requiredDigestValue(input.digest, 'nonce');
  const qop = input.digest.qop?.split(',').map((value) => value.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001';
  const cnonce = randomBytes(8).toString('hex');
  const ha1 = md5(`${input.username}:${realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    ['username', input.username],
    ['realm', realm],
    ['nonce', nonce],
    ['uri', input.uri],
    ['response', response],
    ['algorithm', algorithm]
  ];

  if (input.digest.opaque) {
    parts.push(['opaque', input.digest.opaque]);
  }
  if (qop) {
    parts.push(['qop', qop], ['nc', nc], ['cnonce', cnonce]);
  }

  return `Digest ${parts.map(([key, value]) => `${key}="${value}"`).join(', ')}`;
}

async function readJsonlDir(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const events = [];
  for (const entry of entries.filter((fileName) => fileName.startsWith(prefix)).sort()) {
    const content = await readFile(path.join(dir, entry), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim()) {
        events.push(JSON.parse(line));
      }
    }
  }
  return events.sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));
}

function latestCameraCredentials(events) {
  const byCameraId = new Map();
  for (const event of events) {
    if (event.type === 'secret.camera.credentials.set') {
      byCameraId.set(event.camera_id, {
        cameraId: event.camera_id,
        host: event.payload.host,
        username: event.payload.username,
        password: event.payload.password
      });
    }
  }
  return Array.from(byCameraId.values());
}

async function appendCameraEvent(event) {
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  const storedEvent = {
    id: randomUUID(),
    ts_ms: Date.now(),
    schema: 1,
    ...event
  };
  const day = new Date(storedEvent.ts_ms).toISOString().slice(0, 10);
  const filePath = path.join(eventsDir, `cameras-${day}.jsonl`);
  await writeFile(filePath, `${JSON.stringify(storedEvent)}\n`, {
    encoding: 'utf8',
    flag: 'a',
    mode: 0o600
  });
}

function parseDigestChallenge(value) {
  const digest = {};
  const challenge = value.replace(/^Digest\s+/i, '');
  const pattern = /([a-z0-9_-]+)=("([^"]*)"|([^,]*))/gi;
  let match;
  while ((match = pattern.exec(challenge))) {
    digest[match[1]] = match[3] ?? match[4] ?? '';
  }
  return digest;
}

function requiredDigestValue(digest, key) {
  const value = digest[key];
  if (!value) {
    throw new Error(`Digest challenge missing ${key}`);
  }
  return value;
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}
