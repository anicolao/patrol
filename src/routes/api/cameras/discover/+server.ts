import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
  appendDiscoveryCompleted,
  appendDiscoveryInitiated
} from '$lib/server/camera-events';
import { discoverOnvifCameras } from '$lib/server/onvif-discovery';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function GET() {
  return json(await currentCameraStateSnapshot());
}

export async function POST() {
  const runId = randomUUID();
  await appendDiscoveryInitiated(runId);
  const result = await discoverOnvifCameras();
  await appendDiscoveryCompleted(runId, result);
  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}
