import type { PatrolEvent } from '$lib/events';
import { appendEvent, readEvents } from '$lib/server/event-store';

const SYSTEM_STREAM = 'system';

export interface SystemProcessHeartbeatPayload {
  processId: string;
  label: string;
  kind: 'server' | 'worker';
  pid: number | null;
  host: string | null;
  detail: string | null;
}

export interface SystemProcessExitedPayload extends SystemProcessHeartbeatPayload {
  exitCode: number | null;
  signal: string | null;
}

export async function appendSystemProcessHeartbeat(payload: SystemProcessHeartbeatPayload) {
  return await appendEvent<SystemProcessHeartbeatPayload>(SYSTEM_STREAM, {
    type: 'system.process.heartbeat',
    source: payload.processId,
    payload
  });
}

export async function readSystemEvents(): Promise<PatrolEvent[]> {
  return await readEvents(SYSTEM_STREAM);
}
