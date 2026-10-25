import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const eventsDir = path.join(dataRoot, 'events');
const host = hostname();
const gitRevision = resolveGitRevision();

export async function appendCameraEvent(event) {
  return await appendEvent('cameras', event);
}

export async function appendCameraEvents(events) {
  return await appendEvents('cameras', events);
}

export async function appendSystemEvent(event) {
  return await appendEvent('system', event);
}

export async function appendProcessHeartbeat(input) {
  return await appendSystemEvent({
    type: 'system.process.heartbeat',
    source: input.processId,
    payload: {
      processId: input.processId,
      label: input.label,
      kind: input.kind,
      pid: process.pid,
      host,
      gitRevision,
      detail: input.detail ?? null
    }
  });
}

export function startProcessHeartbeats(input, options = {}) {
  const intervalMs = input.intervalMs ?? Number(process.env.PATROL_PROCESS_HEARTBEAT_MS ?? '30000');
  const appendHeartbeat = options.appendHeartbeat ?? appendProcessHeartbeat;
  let appendInFlight = false;

  const appendIfIdle = async () => {
    if (appendInFlight) {
      return;
    }
    appendInFlight = true;
    try {
      await appendHeartbeat(input);
    } catch (error) {
      console.error(`failed to append ${input.processId} heartbeat:`, error);
    } finally {
      appendInFlight = false;
    }
  };

  void appendIfIdle();

  const interval = setInterval(() => {
    void appendIfIdle();
  }, intervalMs);

  return interval;
}

export async function appendProcessExited(input) {
  return await appendSystemEvent({
    type: 'system.process.exited',
    source: input.processId,
    payload: {
      processId: input.processId,
      label: input.label,
      kind: input.kind,
      pid: process.pid,
      host,
      gitRevision,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      detail: input.detail ?? null
    }
  });
}

function resolveGitRevision() {
  return process.env.PATROL_GIT_REVISION || process.env.VITE_PATROL_GIT_REVISION || null;
}

async function appendEvent(stream, event) {
  const [storedEvent] = await appendEvents(stream, [event]);
  return storedEvent;
}

async function appendEvents(stream, events) {
  if (events.length === 0) {
    return [];
  }
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  const nowMs = Date.now();
  const storedEvents = events.map((event) => ({
    id: randomUUID(),
    ts_ms: nowMs,
    schema: 1,
    ...event
  }));
  const eventsByDay = Map.groupBy(
    storedEvents,
    (event) => new Date(event.ts_ms).toISOString().slice(0, 10)
  );
  await Promise.all(
    Array.from(eventsByDay, async ([day, dayEvents]) => {
      const filePath = path.join(eventsDir, `${stream}-${day}.jsonl`);
      await writeFile(filePath, `${dayEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600
      });
    })
  );
  return storedEvents;
}
