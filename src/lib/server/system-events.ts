import type { PatrolEvent } from '$lib/events';
import { appendEvent, readEvents } from '$lib/server/event-store';

const SYSTEM_STREAM = 'system';
const gitRevision = import.meta.env.VITE_PATROL_GIT_REVISION ?? null;

export interface SystemProcessHeartbeatPayload {
  processId: string;
  label: string;
  kind: 'server' | 'worker';
  pid: number | null;
  host: string | null;
  gitRevision: string | null;
  detail: string | null;
}

export interface SystemProcessExitedPayload extends SystemProcessHeartbeatPayload {
  exitCode: number | null;
  signal: string | null;
}

type SystemProcessHeartbeatInput = Omit<SystemProcessHeartbeatPayload, 'gitRevision'> & {
  gitRevision?: string | null;
};

export async function appendSystemProcessHeartbeat(payload: SystemProcessHeartbeatInput) {
  const stampedPayload: SystemProcessHeartbeatPayload = {
    ...payload,
    gitRevision: payload.gitRevision ?? gitRevision
  };

  return await appendEvent<SystemProcessHeartbeatPayload>(SYSTEM_STREAM, {
    type: 'system.process.heartbeat',
    source: stampedPayload.processId,
    payload: stampedPayload
  });
}

export async function readSystemEvents(): Promise<PatrolEvent[]> {
  return await readEvents(SYSTEM_STREAM);
}
