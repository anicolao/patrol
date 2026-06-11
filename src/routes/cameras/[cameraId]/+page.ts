import { error } from '@sveltejs/kit';
import type { CameraDiscoveryState } from '$lib/cameras/discovery';

export const ssr = false;

export async function load({ params, fetch }) {
  const response = await fetch('/api/state');
  if (!response.ok) {
    error(response.status, `Camera state failed with HTTP ${response.status}.`);
  }

  const state = (await response.json()) as CameraDiscoveryState;
  const cameraId = decodeURIComponent(params.cameraId);
  const camera = state.devices.find((device) => device.id === cameraId);

  if (!camera) {
    error(404, 'Camera not found.');
  }

  if (!camera.credentials) {
    error(404, 'Camera credentials have not been saved.');
  }

  return {
    camera
  };
}
