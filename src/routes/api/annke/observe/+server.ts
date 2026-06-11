import { json } from '@sveltejs/kit';
import {
  appendAnnkeAiObservationRequested,
  currentCameraDiscoveryState
} from '$lib/server/camera-events';
import { observeAnnkeAiCapabilities } from '$lib/server/annke-observer';
import { readLatestCameraCredentials } from '$lib/server/secrets';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function POST() {
  const state = await currentCameraDiscoveryState();
  const cameras = state.devices.filter((camera) => camera.credentials);
  await appendAnnkeAiObservationRequested({ cameraIds: cameras.map((camera) => camera.id) });

  for (const camera of cameras) {
    const credentials = await readLatestCameraCredentials(camera.id);
    if (!credentials) {
      continue;
    }
    await observeAnnkeAiCapabilities(credentials);
  }

  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}
