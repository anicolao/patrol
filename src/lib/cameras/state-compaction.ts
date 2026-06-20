import type { CameraDiscoveryState, RecordingSegment, ReviewableSecurityEvent } from '$lib/cameras/discovery';
import type { CameraStateSnapshot } from '$lib/events';

export const UI_RECORDING_EVENT_LIMIT = 500;
export const UI_RECORDING_SEGMENT_LIMIT = 2500;

export function compactCameraStateSnapshot(snapshot: CameraStateSnapshot): CameraStateSnapshot {
  return {
    ...snapshot,
    state: compactCameraDiscoveryState(snapshot.state)
  };
}

export function compactCameraDiscoveryState(state: CameraDiscoveryState): CameraDiscoveryState {
  const events = state.recordings.events.slice(0, UI_RECORDING_EVENT_LIMIT);
  const segments = compactRecordingSegments(state.recordings.segments, events);

  return {
    ...state,
    recordings: {
      ...state.recordings,
      events,
      segments
    }
  };
}

function compactRecordingSegments(segments: RecordingSegment[], events: ReviewableSecurityEvent[]) {
  const compacted = new Map<string, RecordingSegment>();

  for (const segment of segments.slice(0, UI_RECORDING_SEGMENT_LIMIT)) {
    compacted.set(segment.relativePath, segment);
  }

  for (const event of events) {
    if (event.preferredSegment) {
      compacted.set(event.preferredSegment.relativePath, event.preferredSegment);
    }
  }

  return Array.from(compacted.values()).sort(
    (left, right) => right.startMs - left.startMs || left.relativePath.localeCompare(right.relativePath)
  );
}
