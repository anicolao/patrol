import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
  appendDiscoveryCompleted,
  appendDiscoveryInitiated,
  currentCameraDiscoveryState
} from '$lib/server/camera-events';
import { discoverOnvifCameras } from '$lib/server/onvif-discovery';

export async function GET() {
  return json(await currentCameraDiscoveryState());
}

export async function POST() {
  const runId = randomUUID();
  await appendDiscoveryInitiated(runId);
  const result = await discoverOnvifCameras();
  await appendDiscoveryCompleted(runId, result);
  return json(await currentCameraDiscoveryState());
}
