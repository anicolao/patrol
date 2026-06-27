import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { CameraDiscoveryRawResult, RawProbeResponse } from '$lib/cameras/discovery';

const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 3702;

interface ProbeOptions {
  timeoutMs?: number;
  localAddresses?: string[];
}

interface ProbeResult {
  responses: RawProbeResponse[];
  errors: string[];
}

export async function discoverOnvifCameras(
  options: ProbeOptions = {}
): Promise<CameraDiscoveryRawResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const startedAtMs = Date.now();
  const errors: string[] = [];

  let responses: RawProbeResponse[] = [];
  try {
    const result = await probe(timeoutMs, options.localAddresses ?? discoveryLocalAddresses());
    responses = result.responses;
    errors.push(...result.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    protocol: 'onvif-ws-discovery',
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    responses,
    errors
  };
}

async function probe(timeoutMs: number, localAddresses: string[]): Promise<ProbeResult> {
  const results = await Promise.all(
    localAddresses.map(async (localAddress) => {
      try {
        return await probeLocalAddress(timeoutMs, localAddress);
      } catch (error) {
        return {
          responses: [],
          errors: [`${localAddress}: ${error instanceof Error ? error.message : String(error)}`]
        };
      }
    })
  );

  return {
    responses: results.flatMap((result) => result.responses),
    errors: results.flatMap((result) => result.errors)
  };
}

async function probeLocalAddress(timeoutMs: number, localAddress: string): Promise<ProbeResult> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const messageId = `uuid:${randomUUID()}`;
  const probeMessage = Buffer.from(createProbeMessage(messageId));
  const responses: RawProbeResponse[] = [];
  const errors: string[] = [];

  return await new Promise<ProbeResult>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close(() => resolve({ responses, errors }));
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close(() => reject(error));
    });

    socket.on('message', (message, rinfo) => {
      responses.push({
        remoteAddress: rinfo.address,
        receivedAtMs: Date.now(),
        body: message.toString('utf8')
      });
    });

    socket.bind(0, () => {
      socket.setMulticastTTL(4);
      socket.setMulticastInterface(localAddress);
      socket.send(probeMessage, MULTICAST_PORT, MULTICAST_ADDRESS, (error) => {
        if (error) {
          errors.push(`${localAddress}: ${error.message}`);
        }
      });
    });
  });
}

function discoveryLocalAddresses() {
  const configured = splitAddresses(process.env.PATROL_ONVIF_DISCOVERY_ADDRESSES ?? '');
  if (configured.length > 0) {
    return configured;
  }

  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);

  return Array.from(new Set(addresses)).sort();
}

function splitAddresses(value: string) {
  return value
    .split(/[,\s]+/)
    .map((address) => address.trim())
    .filter(Boolean);
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
