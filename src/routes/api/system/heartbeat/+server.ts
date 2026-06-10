import { json } from '@sveltejs/kit';
import { currentCameraDiscoveryState } from '$lib/server/camera-events';
import { appendSystemProcessHeartbeat } from '$lib/server/system-events';

export async function POST() {
  await appendSystemProcessHeartbeat({
    processId: 'patrol-web',
    label: 'Patrol web/API server',
    kind: 'server',
    pid: process.pid,
    host: null,
    detail: 'SvelteKit API heartbeat route responded'
  });

  return json(await currentCameraDiscoveryState());
}
