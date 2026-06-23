import { json } from '@sveltejs/kit';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';
import { readRecordingSegmentsForWindow, readReviewableEventsForWindow } from '$lib/server/recording-index';

const DEFAULT_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 12 * 60 * 60 * 1000;
const HISTORY_WINDOW_PADDING_MS = 60 * 1000;

export async function GET({ url }) {
  const snapshot = await currentCameraStateSnapshot({ compactForClient: true });
  const configuredCameras = snapshot.state.devices.filter((camera) => camera.credentials);
  const { startMs, endMs } = requestedWindow(url);
  const { segments, availableStartMs, availableEndMs } = await readRecordingSegmentsForWindow(
    configuredCameras,
    startMs,
    endMs
  );
  const events = await readReviewableEventsForWindow(segments, startMs, endMs);

  return json({
    startMs,
    endMs,
    availableStartMs,
    availableEndMs,
    hasOlder: availableStartMs !== null && availableStartMs < startMs,
    hasNewer: availableEndMs !== null && availableEndMs > endMs,
    segments,
    events,
    storage: snapshot.state.recordings.storage
  });
}

function requestedWindow(url: URL) {
  const explicitStartMs = numericParam(url, 'startMs');
  const explicitEndMs = numericParam(url, 'endMs');
  if (explicitStartMs !== null && explicitEndMs !== null && explicitEndMs > explicitStartMs) {
    return boundedWindow(explicitStartMs, explicitEndMs);
  }

  const centerMs = numericParam(url, 'centerMs');
  if (centerMs !== null) {
    return boundedWindow(centerMs - DEFAULT_HISTORY_WINDOW_MS / 2, centerMs + DEFAULT_HISTORY_WINDOW_MS / 2);
  }

  const latestMs = Date.now();
  return boundedWindow(latestMs - DEFAULT_HISTORY_WINDOW_MS + HISTORY_WINDOW_PADDING_MS, latestMs + HISTORY_WINDOW_PADDING_MS);
}

function boundedWindow(startMs: number, endMs: number) {
  const durationMs = Math.min(endMs - startMs, MAX_HISTORY_WINDOW_MS);
  return {
    startMs: Math.floor(endMs - durationMs),
    endMs: Math.floor(endMs)
  };
}

function numericParam(url: URL, name: string) {
  const rawValue = url.searchParams.get(name);
  if (rawValue === null) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}
