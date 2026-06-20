import { createHash, randomBytes } from 'node:crypto';
import { appendAnnkeIsapiResponseObserved } from '$lib/server/camera-events';
import type { ResolvedCameraCredentials } from '$lib/server/secrets';

const ANNKE_CAPABILITY_PATHS = [
  '/ISAPI/System/deviceInfo',
  '/ISAPI/System/Video/inputs/channels/1/motionDetection',
  '/ISAPI/Smart/capabilities'
] as const;

export async function observeAnnkeAiCapabilities(credentials: ResolvedCameraCredentials) {
  const events = [];
  for (const path of ANNKE_CAPABILITY_PATHS) {
    const startedAtMs = Date.now();
    let statusCode: number | null = null;
    let body: string | null = null;
    let error: string | null = null;
    let ok = false;

    try {
      const response = await digestFetch({
        url: new URL(path, `http://${credentials.host}`),
        username: credentials.username,
        password: credentials.password,
        timeoutMs: 10_000
      });
      statusCode = response.status;
      body = await response.text();
      ok = response.ok;
      if (!response.ok) {
        error = `Annke ISAPI ${path} returned HTTP ${response.status}`;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    events.push(
      await appendAnnkeIsapiResponseObserved({
        cameraId: credentials.cameraId,
        host: credentials.host,
        path,
        rawResult: {
          startedAtMs,
          durationMs: Date.now() - startedAtMs,
          ok,
          statusCode,
          body,
          error
        }
      })
    );
  }

  return events;
}

export async function digestFetch(input: {
  url: URL;
  username: string;
  password: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const method = input.method ?? 'GET';
  const controller = input.signal ? null : new AbortController();
  const signal = input.signal ?? controller?.signal;
  const timeout = controller ? setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000) : null;

  try {
    const first = await fetch(input.url, {
      method,
      headers: input.headers,
      body: input.body,
      signal
    });
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
      headers: {
        ...headersToRecord(input.headers),
        authorization
      },
      body: input.body,
      signal
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function digestAuthorization(input: {
  digest: Record<string, string>;
  method: string;
  uri: string;
  username: string;
  password: string;
}) {
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

function parseDigestChallenge(value: string) {
  const digest: Record<string, string> = {};
  const challenge = value.replace(/^Digest\s+/i, '');
  const pattern = /([a-z0-9_-]+)=("([^"]*)"|([^,]*))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(challenge))) {
    digest[match[1]] = match[3] ?? match[4] ?? '';
  }
  return digest;
}

function requiredDigestValue(digest: Record<string, string>, key: string) {
  const value = digest[key];
  if (!value) {
    throw new Error(`Digest challenge missing ${key}`);
  }
  return value;
}

function md5(value: string) {
  return createHash('md5').update(value).digest('hex');
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}
