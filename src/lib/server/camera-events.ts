import type {
  CameraDiscoveryRawResult,
  CameraDiscoveryState,
  DiscoveredCamera,
  RawProbeResponse
} from '$lib/cameras/discovery';
import { appendEvent, readEvents, type PatrolEvent } from '$lib/server/event-store';

const CAMERA_STREAM = 'cameras';

interface DiscoveryInitiatedPayload {
  protocol: 'onvif-ws-discovery';
}

interface DiscoveryCompletedPayload {
  rawResult: CameraDiscoveryRawResult;
}

export async function appendDiscoveryInitiated(runId: string) {
  return await appendEvent<DiscoveryInitiatedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.initiated',
    source: 'patrol-web',
    correlation_id: runId,
    payload: {
      protocol: 'onvif-ws-discovery'
    }
  });
}

export async function appendDiscoveryCompleted(runId: string, rawResult: CameraDiscoveryRawResult) {
  return await appendEvent<DiscoveryCompletedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.completed',
    source: 'patrol-discovery',
    correlation_id: runId,
    payload: {
      rawResult
    }
  });
}

export async function currentCameraDiscoveryState(): Promise<CameraDiscoveryState> {
  return reduceCameraDiscoveryEvents(await readEvents(CAMERA_STREAM));
}

export function reduceCameraDiscoveryEvents(events: PatrolEvent[]): CameraDiscoveryState {
  const devicesById = new Map<string, DiscoveredCamera>();
  let latestCompleted: PatrolEvent<DiscoveryCompletedPayload> | null = null;

  for (const event of events) {
    if (event.type !== 'camera.discovery.completed') {
      continue;
    }

    const completed = event as PatrolEvent<DiscoveryCompletedPayload>;
    const rawResult = completed.payload.rawResult;
    if (!rawResult) {
      continue;
    }
    latestCompleted = completed;

    for (const device of dedupeDevices(rawResult.responses.map(parseProbeResponse))) {
      devicesById.set(device.id, device);
    }
  }

  if (!latestCompleted) {
    return {
      devices: [],
      errors: [],
      lastDiscovery: null
    };
  }

  const rawResult = latestCompleted.payload.rawResult;
  return {
    devices: Array.from(devicesById.values()).sort((a, b) => {
      const left = a.name ?? a.remoteAddress;
      const right = b.name ?? b.remoteAddress;
      return left.localeCompare(right);
    }),
    errors: rawResult.errors,
    lastDiscovery: {
      runId: latestCompleted.correlation_id ?? latestCompleted.id,
      protocol: rawResult.protocol,
      startedAtMs: rawResult.startedAtMs,
      durationMs: rawResult.durationMs,
      completedAtMs: latestCompleted.ts_ms
    }
  };
}

function parseProbeResponse(response: RawProbeResponse): DiscoveredCamera {
  const xaddrs = splitWords(textForTag(response.body, 'XAddrs'));
  const scopes = splitWords(textForTag(response.body, 'Scopes')).map(decodeScope);
  const types = splitWords(textForTag(response.body, 'Types'));
  const endpoint = textForTag(response.body, 'Address');
  const id = endpoint ?? xaddrs[0] ?? `udp:${response.remoteAddress}`;

  return {
    id,
    endpoint,
    remoteAddress: response.remoteAddress,
    xaddrs,
    setupUrl: setupUrl(response.remoteAddress),
    scopes,
    types,
    name: scopeValue(scopes, '/name/'),
    hardware: scopeValue(scopes, '/hardware/'),
    location: scopeValue(scopes, '/location/'),
    vendorHint: inferVendor(scopes, xaddrs)
  };
}

function textForTag(xml: string, tagName: string) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

function splitWords(value: string | null) {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function decodeScope(scope: string) {
  try {
    return decodeURIComponent(scope);
  } catch {
    return scope;
  }
}

function scopeValue(scopes: string[], marker: string) {
  const match = scopes.find((scope) => scope.includes(marker));
  if (!match) {
    return null;
  }

  const [, value] = match.split(marker);
  return value ? value.replace(/\+/g, ' ') : null;
}

function inferVendor(scopes: string[], xaddrs: string[]) {
  const haystack = [...scopes, ...xaddrs].join(' ').toLowerCase();
  if (haystack.includes('annke')) {
    return 'annke';
  }
  if (haystack.includes('hikvision')) {
    return 'hikvision';
  }
  return null;
}

function setupUrl(remoteAddress: string) {
  return remoteAddress.includes(':') ? `http://[${remoteAddress}]` : `http://${remoteAddress}`;
}

function dedupeDevices(devices: DiscoveredCamera[]) {
  const byId = new Map<string, DiscoveredCamera>();
  for (const device of devices) {
    byId.set(device.id, device);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const left = a.name ?? a.remoteAddress;
    const right = b.name ?? b.remoteAddress;
    return left.localeCompare(right);
  });
}

function decodeXml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
