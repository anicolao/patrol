import type { CameraDiscoveryState } from '$lib/cameras/discovery';

export interface PatrolEvent<TPayload = unknown> {
  id: string;
  ts_ms: number;
  type: string;
  source: string;
  schema: 1;
  correlation_id?: string;
  payload: TPayload;
}

export interface EventCursor {
  ts_ms: number;
  id: string;
}

export interface StreamedPatrolEvent<TPayload = unknown> {
  stream: string;
  event: PatrolEvent<TPayload>;
}

export interface CameraStateSnapshot {
  state: CameraDiscoveryState;
  cursor: EventCursor | null;
  cachedAtMs: number;
}

export function compareEventCursor(left: EventCursor, right: EventCursor) {
  return left.ts_ms - right.ts_ms || left.id.localeCompare(right.id);
}

export function cursorForEvent(event: PatrolEvent): EventCursor {
  return {
    ts_ms: event.ts_ms,
    id: event.id
  };
}
