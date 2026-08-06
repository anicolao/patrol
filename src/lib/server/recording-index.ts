import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DiscoveredCamera, RecordingSegment, ReviewableSecurityEvent } from '$lib/cameras/discovery';
import type { PatrolEvent } from '$lib/events';
import { openRecordingCatalog } from './recording-catalog';
import { patrolDataRoot } from './paths';

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
  const streamNames = cameras.flatMap((camera) => [camera.streams.main, camera.streams.sub]);
  const catalog = await openRecordingCatalog(patrolDataRoot());
  try {
    return {
      segments: catalog.segmentsForWindow(streamNames, startMs, endMs),
      ...catalog.availableBounds(streamNames)
    };
  } finally {
    catalog.close();
  }
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

async function readCameraEventsForWindow(startMs: number, endMs: number) {
  const eventDir = path.join(patrolDataRoot(), 'events');
  const eventFiles = eventFileNamesForWindow('cameras', startMs, endMs);
  const events: PatrolEvent[] = [];

  await Promise.all(
    eventFiles.map(async (eventFile) => {
      const input = createReadStream(path.join(eventDir, eventFile), { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
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
      } catch {
        // Missing daily event files simply contribute no events to the window.
      }
    })
  );

  return events.sort((left, right) => left.ts_ms - right.ts_ms || left.id.localeCompare(right.id));
}

function eventFileNamesForWindow(stream: string, startMs: number, endMs: number) {
  const names = new Set<string>();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDayMs = Math.floor((startMs - dayMs) / dayMs) * dayMs;
  const lastDayMs = Math.floor((endMs + dayMs) / dayMs) * dayMs;

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
