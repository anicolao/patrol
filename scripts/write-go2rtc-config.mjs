import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const eventsDir = path.join(dataRoot, 'events');
const secretsDir = path.join(dataRoot, 'secrets');
const go2rtcDir = path.join(dataRoot, 'go2rtc');

const cameras = reduceCameras(await readJsonlDir(eventsDir, 'cameras-'));
const secrets = latestSecretsByCamera(await readJsonlDir(secretsDir, 'secrets-'));
const configured = cameras.filter((camera) => secrets.has(camera.id));
const config = renderConfig(configured, secrets);

await mkdir(go2rtcDir, { recursive: true, mode: 0o700 });
const configPath = path.join(go2rtcDir, 'go2rtc.yaml');
await writeFile(configPath, config, { encoding: 'utf8', mode: 0o600 });
await appendCameraEvent({
  type: 'go2rtc.config.materialized',
  source: 'patrol-go2rtc-config',
  payload: {
    apiBaseUrl: 'http://127.0.0.1:1984',
    configPath,
    streams: configured.flatMap((camera) => [
      {
        cameraId: camera.id,
        role: 'main',
        streamName: camera.streams.main
      },
      {
        cameraId: camera.id,
        role: 'sub',
        streamName: camera.streams.sub
      }
    ])
  }
});
console.log(configPath);

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

function reduceCameras(events) {
  const camerasById = new Map();
  const configuredCameraIds = new Set();

  for (const event of events) {
    if (event.type === 'camera.credentials.saved') {
      configuredCameraIds.add(event.payload.cameraId);
      continue;
    }

    if (event.type !== 'camera.discovery.completed') {
      continue;
    }

    const responses = event.payload.rawResult?.responses ?? [];
    for (const response of responses) {
      const camera = parseProbeResponse(response);
      camerasById.set(camera.id, camera);
    }
  }

  return Array.from(camerasById.values()).filter((camera) => configuredCameraIds.has(camera.id));
}

function parseProbeResponse(response) {
  const xaddrs = splitWords(textForTag(response.body, 'XAddrs'));
  const scopes = splitWords(textForTag(response.body, 'Scopes')).map(decodeScope);
  const endpoint = textForTag(response.body, 'Address');
  const id = endpoint ?? xaddrs[0] ?? `udp:${response.remoteAddress}`;

  return {
    id,
    remoteAddress: response.remoteAddress,
    streams: streamNames(scopes, response.remoteAddress, id)
  };
}

function latestSecretsByCamera(events) {
  const secrets = new Map();
  for (const event of events) {
    if (event.type === 'secret.camera.credentials.set') {
      secrets.set(event.camera_id, {
        host: event.payload.host,
        username: event.payload.username,
        password: event.payload.password
      });
    }
  }
  return secrets;
}

function renderConfig(cameras, secrets) {
  return [
    'api:',
    '  listen: "127.0.0.1:1984"',
    'rtsp:',
    '  listen: "127.0.0.1:8554"',
    'webrtc:',
    '  listen: ":8555"',
    'streams:',
    ...cameras.flatMap((camera) => {
      const credentials = secrets.get(camera.id);
      return [
        `  ${yamlKey(camera.streams.main)}:`,
        `    - ${yamlString(annkeRtspUrl(credentials, 'main'))}`,
        `  ${yamlKey(camera.streams.sub)}:`,
        `    - ${yamlString(annkeRtspUrl(credentials, 'sub'))}`
      ];
    })
  ].join('\n') + '\n';
}

function annkeRtspUrl(credentials, profile) {
  const host = credentials.host.includes(':') ? `[${credentials.host}]` : credentials.host;
  const username = encodeURIComponent(credentials.username);
  const password = encodeURIComponent(credentials.password);
  return `rtsp://${username}:${password}@${host}:554/H265/ch%201/${profile}/av_stream`;
}

function textForTag(xml, tagName) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

function splitWords(value) {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function decodeScope(scope) {
  try {
    return decodeURIComponent(scope);
  } catch {
    return scope;
  }
}

function scopeValue(scopes, marker) {
  const match = scopes.find((scope) => scope.includes(marker));
  if (!match) {
    return null;
  }

  const [, value] = match.split(marker);
  return value ? value.replace(/\+/g, ' ') : null;
}

function streamNames(scopes, remoteAddress, id) {
  const rawName = scopeValue(scopes, '/name/') ?? scopeValue(scopes, '/hardware/') ?? remoteAddress ?? id;
  const baseName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const streamBase = baseName || `camera_${Math.abs(hashString(id))}`;
  return {
    main: `${streamBase}_main`,
    sub: `${streamBase}_sub`
  };
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function yamlKey(value) {
  return /^[A-Za-z0-9_]+$/.test(value) ? value : yamlString(value);
}

function yamlString(value) {
  return JSON.stringify(value);
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
