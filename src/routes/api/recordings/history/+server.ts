import { json } from '@sveltejs/kit';
import type { RecordingSegment, ReviewableSecurityEvent } from '$lib/cameras/discovery';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

const DEFAULT_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 12 * 60 * 60 * 1000;
const HISTORY_WINDOW_PADDING_MS = 60 * 1000;

export async function GET({ url }) {
  const snapshot = await currentCameraStateSnapshot({ compactForClient: false });
  const allSegments = snapshot.state.recordings.segments;
  const allEvents = snapshot.state.recordings.events;
  const { startMs, endMs } = requestedWindow(url, allSegments, allEvents);

  const segments = allSegments
    .filter((segment) => overlaps(segment.startMs, segment.endMs, startMs, endMs))
    .sort((left, right) => right.startMs - left.startMs || left.relativePath.localeCompare(right.relativePath));
  const events = allEvents
    .filter((event) => event.occurredAtMs >= startMs && event.occurredAtMs <= endMs)
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs || left.id.localeCompare(right.id));

  const availableStartMs = minDefined(allSegments.map((segment) => segment.startMs));
  const availableEndMs = maxDefined(allSegments.map((segment) => segment.endMs));

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

function requestedWindow(url: URL, segments: RecordingSegment[], events: ReviewableSecurityEvent[]) {
  const explicitStartMs = numericParam(url, 'startMs');
  const explicitEndMs = numericParam(url, 'endMs');
  if (explicitStartMs !== null && explicitEndMs !== null && explicitEndMs > explicitStartMs) {
    return boundedWindow(explicitStartMs, explicitEndMs);
  }

  const centerMs = numericParam(url, 'centerMs');
  if (centerMs !== null) {
    return boundedWindow(centerMs - DEFAULT_HISTORY_WINDOW_MS / 2, centerMs + DEFAULT_HISTORY_WINDOW_MS / 2);
  }

  const latestMs =
    maxDefined([
      ...segments.map((segment) => segment.endMs),
      ...events.map((event) => event.occurredAtMs)
    ]) ?? Date.now();
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

function overlaps(leftStartMs: number, leftEndMs: number, rightStartMs: number, rightEndMs: number) {
  return leftStartMs <= rightEndMs && leftEndMs >= rightStartMs;
}

function minDefined(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : null;
}

function maxDefined(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}
