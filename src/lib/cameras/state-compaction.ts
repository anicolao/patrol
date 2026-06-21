import type { CameraDiscoveryState, RecordingSegment, ReviewableSecurityEvent } from '$lib/cameras/discovery';
import type { CameraStateSnapshot } from '$lib/events';

export const UI_RECORDING_EVENT_LIMIT = 500;
export const UI_RECORDING_SEGMENT_LIMIT = 300;
export const UI_PERSON_SAMPLE_LIMIT = 300;
export const UI_PERSON_REFERENCE_SAMPLE_LIMIT_PER_LABEL = 8;

export function compactCameraStateSnapshot(snapshot: CameraStateSnapshot): CameraStateSnapshot {
  return {
    ...snapshot,
    state: compactCameraDiscoveryState(snapshot.state)
  };
}

export function compactCameraDiscoveryState(state: CameraDiscoveryState): CameraDiscoveryState {
  const events = state.recordings.events.slice(0, UI_RECORDING_EVENT_LIMIT);
  const segments = compactRecordingSegments(state.recordings.segments, events);
  const people = state.people ?? {
    samples: [],
    labels: [],
    labelCounts: {},
    unlabeledCount: 0,
    labeledCount: 0
  };
  const samples = compactPersonSamples(people.samples);

  return {
    ...state,
    recordings: {
      ...state.recordings,
      events,
      segments
    },
    people: {
      ...people,
      labelCounts: people.labelCounts ?? {},
      samples
    }
  };
}

function compactPersonSamples(samples: CameraDiscoveryState['people']['samples']) {
  const compacted = new Map<string, CameraDiscoveryState['people']['samples'][number]>();

  for (const sample of samples.slice(0, UI_PERSON_SAMPLE_LIMIT)) {
    compacted.set(sample.id, sample);
  }

  const namedLabels = Array.from(
    new Set(
      samples
        .map((sample) => sample.label)
        .filter((label): label is string => typeof label === 'string' && !label.startsWith('anonymous:'))
    )
  );

  for (const label of namedLabels) {
    const references = samples
      .filter((sample) => sample.label === label && sample.status === 'analyzed' && sample.cropUrl)
      .sort((left, right) => (right.labeledAtMs ?? 0) - (left.labeledAtMs ?? 0) || right.occurredAtMs - left.occurredAtMs)
      .slice(0, UI_PERSON_REFERENCE_SAMPLE_LIMIT_PER_LABEL);
    for (const sample of references) {
      compacted.set(sample.id, sample);
    }
  }

  return Array.from(compacted.values()).sort(
    (left, right) => right.occurredAtMs - left.occurredAtMs || left.id.localeCompare(right.id)
  );
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
