import { json } from '@sveltejs/kit';
import { digestFetch } from '$lib/server/annke-observer';
import { requireCameraControl, resolveControlledCamera, runCameraControl } from '$lib/server/camera-control';

const LIGHT_PATH = '/ISAPI/Image/channels/1/supplementLight';
const MODES = new Set(['close', 'eventIntelligence', 'colorVuWhiteLight', 'irLight']);

export async function GET({ params }) {
  const { camera, credentials } = await resolveControlledCamera(params.cameraId);
  if (!camera.controls.supplementLight.supported) {
    return json({ supported: false });
  }

  const response = await digestFetch({
    url: new URL(LIGHT_PATH, `http://${credentials.host}`),
    username: credentials.username,
    password: credentials.password,
    timeoutMs: 5000
  });
  const text = await response.text();
  if (!response.ok) {
    return json({ error: text || `Light status failed with HTTP ${response.status}` }, { status: response.status });
  }

  return json({
    supported: true,
    mode: tagValue(text, 'supplementLightMode'),
    whiteLightBrightness: numberTagValue(text, 'whiteLightBrightness'),
    irLightBrightness: numberTagValue(text, 'irLightBrightness')
  });
}

export async function POST({ params, request }) {
  const { camera, credentials } = await resolveControlledCamera(params.cameraId);
  requireCameraControl(camera, 'supplement_light');

  const body = await request.json().catch(() => ({}));
  const mode = typeof body.mode === 'string' && MODES.has(body.mode) ? body.mode : null;
  if (!mode) {
    return json({ error: 'mode must be close, eventIntelligence, colorVuWhiteLight, or irLight.' }, { status: 400 });
  }

  const whiteLightBrightness = mode === 'close' || mode === 'irLight' ? 0 : clampBrightness(body.whiteLightBrightness ?? 100);
  const irLightBrightness = mode === 'close' || mode === 'colorVuWhiteLight' ? 0 : clampBrightness(body.irLightBrightness ?? 100);
  const regulation = mode === 'eventIntelligence' ? 'auto' : 'manual';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SupplementLight version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <supplementLightMode>${mode}</supplementLightMode>
  <mixedLightBrightnessRegulatMode>${regulation}</mixedLightBrightnessRegulatMode>
  <whiteLightBrightness>${whiteLightBrightness}</whiteLightBrightness>
  <irLightBrightness>${irLightBrightness}</irLightBrightness>
  <EventIntelligenceModeCfg>
    <brightnessRegulatMode>${regulation}</brightnessRegulatMode>
    <whiteLightBrightness>${whiteLightBrightness}</whiteLightBrightness>
    <irLightBrightness>${irLightBrightness}</irLightBrightness>
    <associatedVMDHuman>true</associatedVMDHuman>
  </EventIntelligenceModeCfg>
</SupplementLight>`;

  const rawResult = await runCameraControl({
    camera,
    credentials,
    control: 'supplement_light',
    command: 'set_mode',
    parameters: { mode, whiteLightBrightness, irLightBrightness },
    isapiPath: LIGHT_PATH,
    method: 'PUT',
    body: xml
  });

  if (!rawResult.ok) {
    return json({ error: rawResult.error ?? 'Light command failed.' }, { status: rawResult.statusCode ?? 502 });
  }

  return json({ ok: true, mode, whiteLightBrightness, irLightBrightness });
}

function tagValue(xml: string, tag: string) {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
}

function numberTagValue(xml: string, tag: string) {
  const value = Number(tagValue(xml, tag));
  return Number.isFinite(value) ? value : null;
}

function clampBrightness(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 100;
  }
  return Math.max(0, Math.min(100, Math.round(number)));
}
