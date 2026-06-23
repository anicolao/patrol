import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredCamera, RecordingSegment, ReviewableSecurityEvent } from '$lib/cameras/discovery';
import type { PatrolEvent } from '$lib/events';
import { patrolDataRoot, patrolRecordingsDir } from './paths';

const DEFAULT_SEGMENT_MS = 15_000;

interface CameraStream {
  camera: DiscoveredCamera;
  role: 'main' | 'sub';
  streamName: string;
}

interface AnnkeAlertPayload {
  cameraId: string;
  receivedAtMs: number;
  rawXml: string;
}

export async function readRecordingSegmentsForWindow(
  cameras: DiscoveredCamera[],
  startMs: number,
  endMs: number
) {
  const streams = cameraStreams(cameras);
  const recordingsDir = patrolRecordingsDir();
  const segments: RecordingSegment[] = [];
  let availableStartMs: number | null = null;
  let availableEndMs: number | null = null;

  await Promise.all(
    streams.map(async (stream) => {
      const streamDir = path.join(recordingsDir, stream.streamName);
      let entries: string[];
      try {
        entries = await readdir(streamDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const segmentStartMs = segmentStartMsFromFileName(entry);
        if (segmentStartMs === null) {
          continue;
        }

        const segmentEndMs = segmentStartMs + DEFAULT_SEGMENT_MS;
        availableStartMs = availableStartMs === null ? segmentStartMs : Math.min(availableStartMs, segmentStartMs);
        availableEndMs = availableEndMs === null ? segmentEndMs : Math.max(availableEndMs, segmentEndMs);

        if (!overlaps(segmentStartMs, segmentEndMs, startMs, endMs)) {
          continue;
        }

        segments.push({
          cameraId: stream.camera.id,
          role: stream.role,
          streamName: stream.streamName,
          startMs: segmentStartMs,
          endMs: segmentEndMs,
          durationMs: DEFAULT_SEGMENT_MS,
          sizeBytes: 0,
          relativePath: path.join(stream.streamName, entry),
          observedAtMs: segmentEndMs
        });
      }
    })
  );

  return {
    segments: segments.sort((left, right) => right.startMs - left.startMs || left.relativePath.localeCompare(right.relativePath)),
    availableStartMs,
    availableEndMs
  };
}

export async function readReviewableEventsForWindow(
  segments: RecordingSegment[],
  startMs: number,
  endMs: number
) {
  const events: ReviewableSecurityEvent[] = [];

  for (const event of await readCameraEventsForWindow(startMs, endMs)) {
    if (event.type !== 'annke.alert_stream.message_received') {
      continue;
    }

    const payload = event.payload as Partial<AnnkeAlertPayload>;
    if (
      typeof payload.cameraId !== 'string' ||
      typeof payload.receivedAtMs !== 'number' ||
      typeof payload.rawXml !== 'string'
    ) {
      continue;
    }

    if (payload.receivedAtMs < startMs || payload.receivedAtMs > endMs) {
      continue;
    }

    const eventState = textForTag(payload.rawXml, 'eventState');
    if (eventState && eventState !== 'active') {
      continue;
    }

    const eventType = textForTag(payload.rawXml, 'eventType');
    const targetType = textForTag(payload.rawXml, 'targetType');
    events.push({
      id: event.id,
      cameraId: payload.cameraId,
      occurredAtMs: payload.receivedAtMs,
      eventType,
      eventState,
      targetType,
      label: recordingEventLabel(targetType, eventType),
      sourceEventId: event.id,
      preferredSegment: preferredSegmentForEvent(segments, payload.cameraId, payload.receivedAtMs)
    });
  }

  return events.sort((left, right) => right.occurredAtMs - left.occurredAtMs || left.id.localeCompare(right.id));
}

function cameraStreams(cameras: DiscoveredCamera[]): CameraStream[] {
  return cameras.flatMap((camera) => [
    {
      camera,
      role: 'main' as const,
      streamName: camera.streams.main
    },
    {
      camera,
      role: 'sub' as const,
      streamName: camera.streams.sub
    }
  ]);
}

function segmentStartMsFromFileName(fileName: string) {
  if (!fileName.endsWith('.mp4')) {
    return null;
  }

  const seconds = Number(fileName.slice(0, -'.mp4'.length));
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return null;
  }

  return seconds * 1000;
}

async function readCameraEventsForWindow(startMs: number, endMs: number) {
  const eventDir = path.join(patrolDataRoot(), 'events');
  const eventFiles = eventFileNamesForWindow('cameras', startMs, endMs);
  const events: PatrolEvent[] = [];

  await Promise.all(
    eventFiles.map(async (eventFile) => {
      let content: string;
      try {
        content = await readFile(path.join(eventDir, eventFile), 'utf8');
      } catch {
        return;
      }

      for (const line of content.split('\n')) {
        if (!line.trim()) {
          continue;
        }

        try {
          const event = JSON.parse(line) as PatrolEvent;
          if (event.ts_ms >= startMs - 24 * 60 * 60 * 1000 && event.ts_ms <= endMs + 24 * 60 * 60 * 1000) {
            events.push(event);
          }
        } catch {
          continue;
        }
      }
    })
  );

  return events.sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));
}

function eventFileNamesForWindow(stream: string, startMs: number, endMs: number) {
  const names = new Set<string>();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDayMs = Math.floor(startMs / dayMs) * dayMs;
  const lastDayMs = Math.floor(endMs / dayMs) * dayMs;

  for (let dayMsValue = firstDayMs; dayMsValue <= lastDayMs; dayMsValue += dayMs) {
    names.add(`${stream}-${new Date(dayMsValue).toISOString().slice(0, 10)}.jsonl`);
  }

  return Array.from(names).sort();
}

function preferredSegmentForEvent(segments: RecordingSegment[], cameraId: string, occurredAtMs: number) {
  const candidates = segments.filter(
    (segment) => segment.cameraId === cameraId && occurredAtMs >= segment.startMs && occurredAtMs <= segment.endMs
  );
  return candidates.find((segment) => segment.role === 'main') ?? candidates.find((segment) => segment.role === 'sub') ?? null;
}

function textForTag(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`));
  return match?.[1]?.trim() || null;
}

function recordingEventLabel(targetType: string | null, eventType: string | null) {
  if (targetType === 'human') {
    return 'Person';
  }
  if (targetType === 'vehicle') {
    return 'Vehicle';
  }
  if (eventType === 'videoloss') {
    return 'Video lost';
  }
  if (eventType === 'VMD' || eventType === 'linedetection' || eventType === 'fielddetection') {
    return 'Motion';
  }
  return eventType ?? targetType ?? 'Camera event';
}

function overlaps(leftStartMs: number, leftEndMs: number, rightStartMs: number, rightEndMs: number) {
  return leftStartMs <= rightEndMs && leftEndMs >= rightStartMs;
}
