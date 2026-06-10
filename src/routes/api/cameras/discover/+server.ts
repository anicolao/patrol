import { json } from '@sveltejs/kit';
import { discoverOnvifCameras } from '$lib/server/onvif-discovery';

export async function POST() {
  const result = await discoverOnvifCameras();
  return json(result);
}
