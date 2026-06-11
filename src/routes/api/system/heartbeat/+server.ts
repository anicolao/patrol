import { json } from '@sveltejs/kit';
import { currentCameraDiscoveryState } from '$lib/server/camera-events';
import { appendSystemProcessHeartbeat } from '$lib/server/system-events';

export async function POST({ url }) {
  const event = await appendSystemProcessHeartbeat({
    processId: 'patrol-web',
    label: 'Patrol web/API server',
    kind: 'server',
    pid: process.pid,
    host: null,
    detail: 'SvelteKit API heartbeat route responded'
  });

  if (url.searchParams.get('event') === '1') {
    return json({
      stream: 'system',
      event
    });
  }

  return json(await currentCameraDiscoveryState());
}
