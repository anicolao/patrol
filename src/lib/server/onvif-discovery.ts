import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import type { CameraDiscoveryResult, DiscoveredCamera } from '$lib/cameras/discovery';

const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 3702;

interface ProbeOptions {
  timeoutMs?: number;
}

interface ProbeResponse {
  body: string;
  remoteAddress: string;
}

export async function discoverOnvifCameras(options: ProbeOptions = {}): Promise<CameraDiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const startedAtMs = Date.now();
  const errors: string[] = [];

  let responses: ProbeResponse[] = [];
  try {
    responses = await probe(timeoutMs);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const devices = dedupeDevices(responses.map(parseProbeResponse));

  return {
    protocol: 'onvif-ws-discovery',
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    devices,
    errors
  };
}

async function probe(timeoutMs: number): Promise<ProbeResponse[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const messageId = `uuid:${randomUUID()}`;
  const probeMessage = Buffer.from(createProbeMessage(messageId));
  const responses: ProbeResponse[] = [];

  return await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close(() => resolve(responses));
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close(() => reject(error));
    });

    socket.on('message', (message, rinfo) => {
      responses.push({
        body: message.toString('utf8'),
        remoteAddress: rinfo.address
      });
    });

    socket.bind(0, () => {
      socket.setMulticastTTL(4);
      socket.send(probeMessage, MULTICAST_PORT, MULTICAST_ADDRESS, (error) => {
        if (error) {
          clearTimeout(timer);
          socket.removeAllListeners();
          socket.close(() => reject(error));
        }
      });
    });
  });
}

function createProbeMessage(messageId: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;
}

function parseProbeResponse(response: ProbeResponse): DiscoveredCamera {
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
  const match = xml.match(new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i'));
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
