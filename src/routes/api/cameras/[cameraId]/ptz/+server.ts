import { json } from '@sveltejs/kit';
import { requireCameraControl, resolveControlledCamera, runCameraControl } from '$lib/server/camera-control';

const MAX_SPEED = 100;

export async function POST({ params, request }) {
  const { camera, credentials } = await resolveControlledCamera(params.cameraId);
  requireCameraControl(camera, 'ptz');

  const body = await request.json().catch(() => ({}));
  const action = body.action === 'stop' ? 'stop' : 'move';
  const pan = action === 'stop' ? 0 : clampSpeed(body.pan ?? 0);
  const tilt = action === 'stop' ? 0 : clampSpeed(body.tilt ?? 0);
  const zoom = action === 'stop' ? 0 : clampSpeed(body.zoom ?? 0);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PTZData version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <pan>${pan}</pan>
  <tilt>${tilt}</tilt>
  <zoom>${zoom}</zoom>
</PTZData>`;

  const rawResult = await runCameraControl({
    camera,
    credentials,
    control: 'ptz',
    command: action,
    parameters: { pan, tilt, zoom },
    isapiPath: '/ISAPI/PTZCtrl/channels/1/continuous',
    method: 'PUT',
    body: xml
  });

  if (!rawResult.ok) {
    return json({ error: rawResult.error ?? 'PTZ command failed.' }, { status: rawResult.statusCode ?? 502 });
  }

  return json({ ok: true, action, pan, tilt, zoom });
}

function clampSpeed(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Math.round(number)));
}
