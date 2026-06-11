import { json } from '@sveltejs/kit';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function GET({ url }) {
  return json(await currentCameraStateSnapshot({ forceRefresh: url.searchParams.get('fresh') === '1' }));
}
