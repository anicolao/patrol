import { error } from '@sveltejs/kit';
import type { DiscoveredCamera } from '$lib/cameras/discovery';
import {
  appendCameraControlCompleted,
  appendCameraControlFailed,
  appendCameraControlRequested
} from '$lib/server/camera-events';
import { digestFetch } from '$lib/server/annke-observer';
import { readLatestCameraCredentials, type ResolvedCameraCredentials } from '$lib/server/secrets';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export interface ControlledCamera {
  camera: DiscoveredCamera;
  credentials: ResolvedCameraCredentials;
}

export type CameraControlName = 'ptz' | 'supplement_light';

export async function resolveControlledCamera(identifier: string): Promise<ControlledCamera> {
  const decoded = decodeIdentifier(identifier);
  const snapshot = await currentCameraStateSnapshot({ forceRefresh: false });
  const camera = snapshot.state.devices.find((device) => cameraIdentifierMatches(device, decoded));

  if (!camera) {
    error(404, 'Camera not found.');
  }

  const credentials = await readLatestCameraCredentials(camera.id);
  if (!credentials) {
    error(404, 'Camera credentials have not been saved.');
  }

  return { camera, credentials };
}

export function requireCameraControl(camera: DiscoveredCamera, control: CameraControlName) {
  if (control === 'ptz' && camera.controls.ptz.supported) {
    return;
  }
  if (control === 'supplement_light' && camera.controls.supplementLight.supported) {
    return;
  }

  error(400, `Camera ${displayName(camera)} does not report ${control} support.`);
}

export async function runCameraControl(input: {
  camera: DiscoveredCamera;
  credentials: ResolvedCameraCredentials;
  control: CameraControlName;
  command: string;
  parameters: Record<string, string | number | boolean | null>;
  isapiPath: string;
  method: string;
  body: string;
}) {
  const startedAtMs = Date.now();
  await appendCameraControlRequested({
    cameraId: input.camera.id,
    host: input.credentials.host,
    control: input.control,
    command: input.command,
    parameters: input.parameters
  });

  try {
    const response = await digestFetch({
      url: new URL(input.isapiPath, `http://${input.credentials.host}`),
      username: input.credentials.username,
      password: input.credentials.password,
      method: input.method,
      headers: { 'content-type': 'application/xml' },
      body: input.body,
      timeoutMs: 5000
    });
    const text = await response.text();
    const rawResult = {
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
      ok: response.ok,
      statusCode: response.status,
      body: text || null,
      error: response.ok ? null : text || `ISAPI command failed with HTTP ${response.status}`
    };

    await appendCameraControlCompleted({
      cameraId: input.camera.id,
      host: input.credentials.host,
      control: input.control,
      command: input.command,
      parameters: input.parameters,
      rawResult
    });

    return rawResult;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await appendCameraControlFailed({
      cameraId: input.camera.id,
      host: input.credentials.host,
      control: input.control,
      command: input.command,
      parameters: input.parameters,
      error: message
    });
    throw caught;
  }
}

function cameraIdentifierMatches(camera: DiscoveredCamera, identifier: string) {
  return (
    camera.id === identifier ||
    camera.streams.main === identifier ||
    camera.streams.sub === identifier ||
    camera.remoteAddress === identifier ||
    camera.name === identifier ||
    camera.hardware === identifier
  );
}

function displayName(camera: DiscoveredCamera) {
  return camera.name ?? camera.hardware ?? camera.remoteAddress;
}

function decodeIdentifier(identifier: string) {
  try {
    return decodeURIComponent(identifier);
  } catch {
    return identifier;
  }
}
