import type { CameraDiscoveryState, DiscoveredCamera } from '$lib/cameras/discovery';
import { appendCameraAddressRediscovered } from '$lib/server/camera-events';
import { appendCameraCredentials, readLatestCameraCredentials } from '$lib/server/secrets';

export async function updateCredentialsForRediscoveredCameras(
  before: CameraDiscoveryState,
  after: CameraDiscoveryState,
  correlationId: string
) {
  const beforeById = new Map(before.devices.map((camera) => [camera.id, camera]));
  const updates: Array<{ camera: DiscoveredCamera; previous: DiscoveredCamera }> = [];

  for (const camera of after.devices) {
    const previous = beforeById.get(camera.id);
    if (!previous?.credentials || previous.remoteAddress === camera.remoteAddress) {
      continue;
    }
    updates.push({ camera, previous });
  }

  for (const { camera, previous } of updates) {
    const credentials = await readLatestCameraCredentials(camera.id);
    if (!credentials || credentials.host === camera.remoteAddress) {
      continue;
    }

    await appendCameraCredentials({
      cameraId: camera.id,
      host: camera.remoteAddress,
      username: credentials.username,
      password: credentials.password
    });

    await appendCameraAddressRediscovered(
      {
        cameraId: camera.id,
        previousHost: credentials.host,
        rediscoveredHost: camera.remoteAddress,
        previousRemoteAddress: previous.remoteAddress,
        endpoint: camera.endpoint,
        name: camera.name,
        hardware: camera.hardware
      },
      correlationId
    );
  }

  return updates.length;
}
