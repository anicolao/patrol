import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventCursor, PatrolEvent } from '$lib/events';

interface NewPatrolEvent<TPayload> {
  type: string;
  source: string;
  correlation_id?: string;
  payload: TPayload;
}

export async function appendEvent<TPayload>(
  stream: string,
  event: NewPatrolEvent<TPayload>
): Promise<PatrolEvent<TPayload>> {
  const storedEvent: PatrolEvent<TPayload> = {
    id: randomUUID(),
    ts_ms: Date.now(),
    schema: 1,
    ...event
  };

  const filePath = await eventFilePath(stream, storedEvent.ts_ms);
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(storedEvent)}\n`, 'utf8');
  } finally {
    await handle.close();
  }

  return storedEvent;
}

export async function readEvents(stream: string): Promise<PatrolEvent[]> {
  const eventsDir = await eventDir();
  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch {
    return [];
  }

  const eventFiles = entries
    .filter((entry) => entry.startsWith(`${stream}-`) && entry.endsWith('.jsonl'))
    .sort();
  const events: PatrolEvent[] = [];

  for (const eventFile of eventFiles) {
    const content = await readFile(path.join(eventsDir, eventFile), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      events.push(JSON.parse(line) as PatrolEvent);
    }
  }

  return events.sort((a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id));
}

export async function readAllStreamedEvents(streams: string[]): Promise<Array<{ stream: string; event: PatrolEvent }>> {
  const grouped = await Promise.all(
    streams.map(async (stream) => (await readEvents(stream)).map((event) => ({ stream, event })))
  );
  return grouped.flat().sort(compareStreamedEvents);
}

export async function readStreamedEventsAfter(
  streams: string[],
  cursor: EventCursor | null
): Promise<Array<{ stream: string; event: PatrolEvent }>> {
  const events = await readAllStreamedEvents(streams);
  if (!cursor) {
    return events;
  }

  return events.filter(({ event }) => event.ts_ms > cursor.ts_ms || (event.ts_ms === cursor.ts_ms && event.id > cursor.id));
}

export function latestCursorForEvents(events: PatrolEvent[]): EventCursor | null {
  const latest = [...events].sort((a, b) => b.ts_ms - a.ts_ms || b.id.localeCompare(a.id))[0];
  return latest ? { ts_ms: latest.ts_ms, id: latest.id } : null;
}

function compareStreamedEvents(
  left: { stream: string; event: PatrolEvent },
  right: { stream: string; event: PatrolEvent }
) {
  return (
    left.event.ts_ms - right.event.ts_ms ||
    left.event.id.localeCompare(right.event.id) ||
    left.stream.localeCompare(right.stream)
  );
}

async function eventFilePath(stream: string, tsMs: number) {
  const eventsDir = await eventDir();
  const day = new Date(tsMs).toISOString().slice(0, 10);
  return path.join(eventsDir, `${stream}-${day}.jsonl`);
}

async function eventDir() {
  const root = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
  const eventsDir = path.join(root, 'events');
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  return eventsDir;
}
