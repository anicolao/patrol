import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import type { CameraDiscoveryRawResult, RawProbeResponse } from '$lib/cameras/discovery';

const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 3702;

interface ProbeOptions {
  timeoutMs?: number;
}

export async function discoverOnvifCameras(
  options: ProbeOptions = {}
): Promise<CameraDiscoveryRawResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const startedAtMs = Date.now();
  const errors: string[] = [];

  let responses: RawProbeResponse[] = [];
  try {
    responses = await probe(timeoutMs);
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

async function probe(timeoutMs: number): Promise<RawProbeResponse[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const messageId = `uuid:${randomUUID()}`;
  const probeMessage = Buffer.from(createProbeMessage(messageId));
  const responses: RawProbeResponse[] = [];

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
        remoteAddress: rinfo.address,
        receivedAtMs: Date.now(),
        body: message.toString('utf8')
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
