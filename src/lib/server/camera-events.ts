import type {
  CameraDiscoveryResult,
  CameraDiscoveryState,
  DiscoveredCamera
} from '$lib/cameras/discovery';
import { appendEvent, readEvents, type PatrolEvent } from '$lib/server/event-store';

const CAMERA_STREAM = 'cameras';

interface DiscoveryInitiatedPayload {
  protocol: 'onvif-ws-discovery';
}

interface DiscoveryCompletedPayload {
  result: CameraDiscoveryResult;
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

export async function appendDiscoveryCompleted(runId: string, result: CameraDiscoveryResult) {
  return await appendEvent<DiscoveryCompletedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.completed',
    source: 'patrol-discovery',
    correlation_id: runId,
    payload: {
      result
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
    latestCompleted = completed;

    for (const device of completed.payload.result.devices) {
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

  const result = latestCompleted.payload.result;
  return {
    devices: Array.from(devicesById.values()).sort((a, b) => {
      const left = a.name ?? a.remoteAddress;
      const right = b.name ?? b.remoteAddress;
      return left.localeCompare(right);
    }),
    errors: result.errors,
    lastDiscovery: {
      runId: latestCompleted.correlation_id ?? latestCompleted.id,
      protocol: result.protocol,
      startedAtMs: result.startedAtMs,
      durationMs: result.durationMs,
      completedAtMs: latestCompleted.ts_ms
    }
  };
}
