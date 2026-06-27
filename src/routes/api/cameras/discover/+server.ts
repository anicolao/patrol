import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
  appendDiscoveryCompleted,
  appendDiscoveryInitiated
} from '$lib/server/camera-events';
import { updateCredentialsForRediscoveredCameras } from '$lib/server/camera-rediscovery';
import { discoverOnvifCameras } from '$lib/server/onvif-discovery';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function GET() {
  return json(await currentCameraStateSnapshot());
}

export async function POST() {
  const runId = randomUUID();
  const before = await currentCameraStateSnapshot({ forceRefresh: true });
  await appendDiscoveryInitiated(runId);
  const result = await discoverOnvifCameras();
  await appendDiscoveryCompleted(runId, result);
  const afterDiscovery = await currentCameraStateSnapshot({ forceRefresh: true });
  await updateCredentialsForRediscoveredCameras(before.state, afterDiscovery.state, runId);
  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}
