import { json } from '@sveltejs/kit';
import { currentCameraDiscoveryState } from '$lib/server/camera-events';

export async function GET() {
  return json(await currentCameraDiscoveryState());
}
