import type {
  AnnkeAiHealth,
  AnnkeCameraAiStatus,
  CameraDiscoveryRawResult,
  CameraDiscoveryState,
  DiscoveredCamera,
  Go2rtcCameraHealth,
  Go2rtcCameraStatus,
  Go2rtcStreamRole,
  Go2rtcStreamStatus,
  RawProbeResponse,
  RecordingSegment,
  RecordingState,
  RecordingStreamRole,
  ReviewableSecurityEvent
} from '$lib/cameras/discovery';
import type { SystemProcessStatus } from '$lib/cameras/discovery';
import {
  compareEventCursor,
  cursorForEvent,
  type CameraStateSnapshot,
  type PatrolEvent,
  type StreamedPatrolEvent
} from '$lib/events';

const DISCOVERY_STALE_AFTER_MS = 60 * 60 * 1000;
const PROCESS_STALE_AFTER_MS = 90 * 1000;
const MAIN_RECORDING_RETENTION_DAYS = 7;
const SUB_RECORDING_RETENTION_DAYS = 30;
const MAIN_ESTIMATED_BITS_PER_SECOND = 8_500_000;
const SUB_ESTIMATED_BITS_PER_SECOND = 700_000;

const SYSTEM_PROCESS_TASKS: Array<
  Pick<SystemProcessStatus, 'id' | 'label' | 'kind' | 'expectedEveryMs'> & { detail: string }
> = [
  {
    id: 'patrol-web',
    label: 'Patrol web/API server',
    kind: 'server',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Serves the SvelteKit UI and API routes'
  },
  {
    id: 'patrol-events-ws',
    label: 'Event WebSocket server',
    kind: 'server',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Streams event log appends to browser clients'
  },
  {
    id: 'patrol-go2rtc',
    label: 'go2rtc stream server',
    kind: 'server',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Fans out camera RTSP streams for preview and live view'
  },
  {
    id: 'patrol-annke-events',
    label: 'Annke alert worker',
    kind: 'worker',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Maintains camera ISAPI alert streams'
  },
  {
    id: 'patrol-watchdog',
    label: 'Watchdog cron',
    kind: 'worker',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Verifies server task health and sends failure notifications'
  },
  {
    id: 'patrol-recorder',
    label: 'Recording worker',
    kind: 'worker',
    expectedEveryMs: PROCESS_STALE_AFTER_MS,
    detail: 'Records main and sub streams into retained video segments'
  }
];

export interface DiscoveryInitiatedPayload {
  protocol: 'onvif-ws-discovery';
}

export interface DiscoveryCompletedPayload {
  rawResult: CameraDiscoveryRawResult;
}

export interface CameraCredentialsSavedPayload {
  cameraId: string;
  host: string;
  secretIds: {
    username: string;
    password: string;
  };
  secretStoredAtMs: number;
}

interface SystemProcessHeartbeatPayload {
  processId: string;
  label: string;
  kind: 'server' | 'worker';
  pid: number | null;
  host: string | null;
  detail: string | null;
}

export interface Go2rtcConfiguredStream {
  cameraId: string;
  role: Go2rtcStreamRole;
  streamName: string;
}

export interface Go2rtcConfigMaterializedPayload {
  apiBaseUrl: string;
  configPath: string;
  streams: Go2rtcConfiguredStream[];
}

export interface Go2rtcObservationRequestedPayload {
  apiBaseUrl: string;
}

export interface Go2rtcStreamsObservedPayload {
  rawResult: {
    apiBaseUrl: string;
    startedAtMs: number;
    durationMs: number;
    ok: boolean;
    statusCode: number | null;
    body: string | null;
    error: string | null;
  };
}

export interface AnnkeAiObservationRequestedPayload {
  cameraIds: string[];
}

export interface AnnkeIsapiResponseObservedPayload {
  cameraId: string;
  host: string;
  path: string;
  rawResult: {
    startedAtMs: number;
    durationMs: number;
    ok: boolean;
    statusCode: number | null;
    body: string | null;
    error: string | null;
  };
}

export interface AnnkeAlertStreamMessageReceivedPayload {
  cameraId: string;
  host: string;
  sourcePath: '/ISAPI/Event/notification/alertStream';
  receivedAtMs: number;
  rawXml: string;
}

export interface RecordingSegmentObservedPayload {
  cameraId: string;
  role: RecordingStreamRole;
  streamName: string;
  startMs: number;
  durationMs: number;
  sizeBytes: number;
  relativePath: string;
}

export interface RecordingSegmentExpiredPayload {
  cameraId: string;
  role: RecordingStreamRole;
  streamName: string;
  startMs: number;
  relativePath: string;
  retentionDays: number;
}

export interface SystemProcessExitedPayload extends SystemProcessHeartbeatPayload {
  exitCode: number | null;
  signal: string | null;
}

export function reduceCameraDiscoveryEvents(
  events: PatrolEvent[],
  systemEvents: PatrolEvent[] = []
): CameraDiscoveryState {
  const devicesById = new Map<string, DiscoveredCamera>();
  const credentialsByCameraId = new Map<string, DiscoveredCamera['credentials']>();
  const go2rtcConfigsByCameraId = new Map<string, Go2rtcCameraConfig>();
  const annkeStateByCameraId = new Map<string, AnnkeCameraAiReducerState>();
  const recordingSegmentsByPath = new Map<string, RecordingSegment>();
  const expiredRecordingPaths = new Set<string>();
  const alertEvents: Array<PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>> = [];
  let latestCompleted: PatrolEvent<DiscoveryCompletedPayload> | null = null;
  let latestGo2rtcObservation: PatrolEvent<Go2rtcStreamsObservedPayload> | null = null;
  const nowMs = Date.now();

  for (const event of events) {
    if (event.type === 'camera.credentials.saved') {
      const saved = event as PatrolEvent<CameraCredentialsSavedPayload>;
      credentialsByCameraId.set(saved.payload.cameraId, {
        savedAtMs: saved.ts_ms,
        usernameSecretId: saved.payload.secretIds.username,
        passwordSecretId: saved.payload.secretIds.password
      });
      continue;
    }

    if (event.type === 'go2rtc.config.materialized') {
      const materialized = event as PatrolEvent<Go2rtcConfigMaterializedPayload>;
      for (const stream of materialized.payload.streams) {
        const config = go2rtcConfigsByCameraId.get(stream.cameraId) ?? {
          configuredAtMs: materialized.ts_ms,
          apiBaseUrl: materialized.payload.apiBaseUrl,
          streams: {}
        };
        config.configuredAtMs = materialized.ts_ms;
        config.apiBaseUrl = materialized.payload.apiBaseUrl;
        config.streams[stream.role] = stream.streamName;
        go2rtcConfigsByCameraId.set(stream.cameraId, config);
      }
      continue;
    }

    if (event.type === 'go2rtc.streams.observed') {
      latestGo2rtcObservation = event as PatrolEvent<Go2rtcStreamsObservedPayload>;
      continue;
    }

    if (event.type === 'annke.isapi.response.observed') {
      const observed = event as PatrolEvent<AnnkeIsapiResponseObservedPayload>;
      const state = annkeStateByCameraId.get(observed.payload.cameraId) ?? {};
      if (observed.payload.path === '/ISAPI/System/Video/inputs/channels/1/motionDetection') {
        state.motionDetection = observed;
      } else if (observed.payload.path === '/ISAPI/Smart/capabilities') {
        state.smartCapabilities = observed;
      } else if (observed.payload.path === '/ISAPI/System/deviceInfo') {
        state.deviceInfo = observed;
      }
      annkeStateByCameraId.set(observed.payload.cameraId, state);
      continue;
    }

    if (event.type === 'annke.alert_stream.message_received') {
      const message = event as PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>;
      const state = annkeStateByCameraId.get(message.payload.cameraId) ?? {};
      if (isAnnkeAiAlert(message.payload.rawXml)) {
        state.lastAlert = message;
        alertEvents.push(message);
      }
      annkeStateByCameraId.set(message.payload.cameraId, state);
      continue;
    }

    if (event.type === 'recording.segment.observed') {
      const observed = event as PatrolEvent<RecordingSegmentObservedPayload>;
      if (!expiredRecordingPaths.has(observed.payload.relativePath) && observed.payload.sizeBytes > 0) {
        recordingSegmentsByPath.set(observed.payload.relativePath, {
          cameraId: observed.payload.cameraId,
          role: observed.payload.role,
          streamName: observed.payload.streamName,
          startMs: observed.payload.startMs,
          endMs: observed.payload.startMs + observed.payload.durationMs,
          durationMs: observed.payload.durationMs,
          sizeBytes: observed.payload.sizeBytes,
          relativePath: observed.payload.relativePath,
          observedAtMs: observed.ts_ms
        });
      }
      continue;
    }

    if (event.type === 'recording.segment.expired') {
      const expired = event as PatrolEvent<RecordingSegmentExpiredPayload>;
      expiredRecordingPaths.add(expired.payload.relativePath);
      recordingSegmentsByPath.delete(expired.payload.relativePath);
      continue;
    }

    if (event.type !== 'camera.discovery.completed') {
      continue;
    }

    const completed = event as PatrolEvent<DiscoveryCompletedPayload>;
    const rawResult = completed.payload.rawResult;
    if (!rawResult) {
      continue;
    }
    latestCompleted = completed;

    for (const device of dedupeDevices(rawResult.responses.map(parseProbeResponse))) {
      const existing = devicesById.get(device.id);
      devicesById.set(device.id, {
        ...device,
        credentials: existing?.credentials ?? null,
        go2rtc: existing?.go2rtc ?? null,
        annke: existing?.annke ?? null
      });
    }
  }

  for (const [cameraId, credentials] of credentialsByCameraId) {
    const device = devicesById.get(cameraId);
    if (device) {
      devicesById.set(cameraId, {
        ...device,
        credentials
      });
    }
  }

  const latestObservedStreams = latestGo2rtcObservation
    ? parseGo2rtcStreams(latestGo2rtcObservation.payload.rawResult.body)
    : new Map<string, Go2rtcObservedStream>();

  for (const [cameraId, device] of devicesById) {
    devicesById.set(cameraId, {
      ...device,
      go2rtc: buildGo2rtcCameraStatus(
        go2rtcConfigsByCameraId.get(cameraId) ?? null,
        latestGo2rtcObservation,
        latestObservedStreams
      ),
      annke: buildAnnkeCameraAiStatus(annkeStateByCameraId.get(cameraId) ?? null)
    });
  }

  if (!latestCompleted) {
    return {
      staleAfterMs: DISCOVERY_STALE_AFTER_MS,
      processes: reduceSystemProcesses(events, systemEvents),
      devices: [],
      recordings: buildRecordingState([], [], 0),
      errors: [],
      lastDiscovery: null
    };
  }

  const rawResult = latestCompleted.payload.rawResult;
  const devices = Array.from(devicesById.values())
    .filter((device) => device.credentials || nowMs - device.lastSeenAtMs <= DISCOVERY_STALE_AFTER_MS)
    .sort((a, b) => {
      const left = a.name ?? a.remoteAddress;
      const right = b.name ?? b.remoteAddress;
      return left.localeCompare(right);
    });
  const recordingSegments = Array.from(recordingSegmentsByPath.values()).sort(
    (a, b) => b.startMs - a.startMs || a.relativePath.localeCompare(b.relativePath)
  );

  return {
    staleAfterMs: DISCOVERY_STALE_AFTER_MS,
    processes: reduceSystemProcesses(events, systemEvents),
    devices,
    recordings: buildRecordingState(recordingSegments, alertEvents, devices.length),
    errors: rawResult.errors,
    lastDiscovery: {
      runId: latestCompleted.correlation_id ?? latestCompleted.id,
      protocol: rawResult.protocol,
      startedAtMs: rawResult.startedAtMs,
      durationMs: rawResult.durationMs,
      completedAtMs: latestCompleted.ts_ms
    }
  };
}

export function reduceCameraStateSnapshotEvent(
  snapshot: CameraStateSnapshot,
  streamedEvent: StreamedPatrolEvent
): CameraStateSnapshot {
  const cursor = cursorForEvent(streamedEvent.event);
  if (snapshot.cursor && compareEventCursor(cursor, snapshot.cursor) <= 0) {
    return snapshot;
  }

  return {
    state: reduceCameraDiscoveryStateEvent(snapshot.state, streamedEvent),
    cursor,
    cachedAtMs: Date.now()
  };
}

function reduceCameraDiscoveryStateEvent(
  state: CameraDiscoveryState,
  streamedEvent: StreamedPatrolEvent
): CameraDiscoveryState {
  const { event, stream } = streamedEvent;

  if (stream === 'system') {
    if (event.type === 'system.process.heartbeat') {
      const heartbeat = event as PatrolEvent<SystemProcessHeartbeatPayload>;
      return withProcessEvent(state, heartbeat.payload.processId, {
        tsMs: heartbeat.ts_ms,
        eventType: heartbeat.type,
        detail: heartbeat.payload.detail,
        healthOverride: null
      });
    }

    if (event.type === 'system.process.exited') {
      const exited = event as PatrolEvent<SystemProcessExitedPayload>;
      return withProcessEvent(state, exited.payload.processId, {
        tsMs: exited.ts_ms,
        eventType: exited.type,
        detail: exited.payload.detail,
        healthOverride: 'error'
      });
    }

    return state;
  }

  if (stream !== 'cameras') {
    return state;
  }

  switch (event.type) {
    case 'camera.discovery.completed':
      return withDiscoveryCompleted(state, event as PatrolEvent<DiscoveryCompletedPayload>);
    case 'camera.credentials.saved':
      return withCameraCredentialsSaved(state, event as PatrolEvent<CameraCredentialsSavedPayload>);
    case 'go2rtc.config.materialized':
      return withGo2rtcConfigMaterialized(state, event as PatrolEvent<Go2rtcConfigMaterializedPayload>);
    case 'go2rtc.streams.observed':
      return withGo2rtcStreamsObserved(state, event as PatrolEvent<Go2rtcStreamsObservedPayload>);
    case 'annke.isapi.response.observed':
      return withAnnkeIsapiResponseObserved(state, event as PatrolEvent<AnnkeIsapiResponseObservedPayload>);
    case 'annke.alert_stream.message_received':
      return withAnnkeAlertStreamMessageReceived(state, event as PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>);
    case 'recording.segment.observed':
      return withRecordingSegmentObserved(state, event as PatrolEvent<RecordingSegmentObservedPayload>);
    case 'recording.segment.expired':
      return withRecordingSegmentExpired(state, event as PatrolEvent<RecordingSegmentExpiredPayload>);
    default:
      return state;
  }
}

function withDiscoveryCompleted(
  state: CameraDiscoveryState,
  event: PatrolEvent<DiscoveryCompletedPayload>
): CameraDiscoveryState {
  const rawResult = event.payload.rawResult;
  const existingById = new Map(state.devices.map((device) => [device.id, device]));
  const discoveredDevices = dedupeDevices(rawResult.responses.map(parseProbeResponse));
  const nowMs = Date.now();

  for (const device of discoveredDevices) {
    const existing = existingById.get(device.id);
    existingById.set(device.id, {
      ...device,
      credentials: existing?.credentials ?? null,
      go2rtc: existing?.go2rtc ?? null,
      annke: existing?.annke ?? null
    });
  }

  const devices = Array.from(existingById.values())
    .filter((device) => device.credentials || nowMs - device.lastSeenAtMs <= DISCOVERY_STALE_AFTER_MS)
    .sort(compareDevices);

  return {
    ...state,
    devices,
    errors: rawResult.errors,
    lastDiscovery: {
      runId: event.correlation_id ?? event.id,
      protocol: rawResult.protocol,
      startedAtMs: rawResult.startedAtMs,
      durationMs: rawResult.durationMs,
      completedAtMs: event.ts_ms
    },
    recordings: rebuildRecordingState(state.recordings.segments, state.recordings.events, devices.length)
  };
}

function withCameraCredentialsSaved(
  state: CameraDiscoveryState,
  event: PatrolEvent<CameraCredentialsSavedPayload>
): CameraDiscoveryState {
  return {
    ...state,
    devices: state.devices.map((device) =>
      device.id === event.payload.cameraId
        ? {
            ...device,
            credentials: {
              savedAtMs: event.ts_ms,
              usernameSecretId: event.payload.secretIds.username,
              passwordSecretId: event.payload.secretIds.password
            }
          }
        : device
    )
  };
}

function withGo2rtcConfigMaterialized(
  state: CameraDiscoveryState,
  event: PatrolEvent<Go2rtcConfigMaterializedPayload>
): CameraDiscoveryState {
  const streamsByCameraId = new Map<string, Partial<Record<Go2rtcStreamRole, string>>>();
  for (const stream of event.payload.streams) {
    streamsByCameraId.set(stream.cameraId, {
      ...(streamsByCameraId.get(stream.cameraId) ?? {}),
      [stream.role]: stream.streamName
    });
  }

  return {
    ...state,
    devices: state.devices.map((device) => {
      const streams = streamsByCameraId.get(device.id);
      if (!streams) {
        return device;
      }

      return {
        ...device,
        go2rtc: go2rtcStatusFromConfiguredStreams(
          {
            configuredAtMs: event.ts_ms,
            apiBaseUrl: event.payload.apiBaseUrl,
            streams: {
              main: streams.main ?? device.go2rtc?.streams.main.streamName,
              sub: streams.sub ?? device.go2rtc?.streams.sub.streamName
            }
          },
          device.go2rtc
        )
      };
    })
  };
}

function withGo2rtcStreamsObserved(
  state: CameraDiscoveryState,
  event: PatrolEvent<Go2rtcStreamsObservedPayload>
): CameraDiscoveryState {
  const observedStreams = parseGo2rtcStreams(event.payload.rawResult.body);
  const devices = state.devices.map((device) => {
    const go2rtc = device.go2rtc;
    if (!go2rtc) {
      return device;
    }

    const config = {
      configuredAtMs: go2rtc.configuredAtMs ?? event.ts_ms,
      apiBaseUrl: go2rtc.apiBaseUrl ?? event.payload.rawResult.apiBaseUrl,
      streams: {
        main: go2rtc.streams.main.streamName,
        sub: go2rtc.streams.sub.streamName
      }
    };

    return {
      ...device,
      go2rtc: buildGo2rtcCameraStatus(config, event, observedStreams)
    };
  });

  return withProcessEvent(
    {
      ...state,
      devices
    },
    'patrol-go2rtc',
    {
      tsMs: event.ts_ms,
      eventType: event.type,
      detail: event.payload.rawResult.ok
        ? 'go2rtc API health check responded'
        : event.payload.rawResult.error ?? 'go2rtc API health check failed',
      healthOverride: event.payload.rawResult.ok ? null : 'error'
    }
  );
}

function withAnnkeIsapiResponseObserved(
  state: CameraDiscoveryState,
  event: PatrolEvent<AnnkeIsapiResponseObservedPayload>
): CameraDiscoveryState {
  const devices = state.devices.map((device) =>
    device.id === event.payload.cameraId
      ? {
          ...device,
          annke: annkeStatusFromIsapiResponse(device.annke, event)
        }
      : device
  );

  return withProcessEvent(
    {
      ...state,
      devices
    },
    'patrol-annke-events',
    {
      tsMs: event.ts_ms,
      eventType: event.type,
      detail: event.payload.rawResult.ok
        ? 'Annke ISAPI health check responded'
        : event.payload.rawResult.error ?? 'Annke ISAPI health check failed',
      healthOverride: event.payload.rawResult.ok ? null : 'error'
    }
  );
}

function withAnnkeAlertStreamMessageReceived(
  state: CameraDiscoveryState,
  event: PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>
): CameraDiscoveryState {
  if (!isAnnkeAiAlert(event.payload.rawXml)) {
    return state;
  }

  const existingDevice = state.devices.find((device) => device.id === event.payload.cameraId);
  const receivedAtMs = event.payload.receivedAtMs ?? existingDevice?.annke?.lastAlert?.receivedAtMs ?? event.ts_ms;
  const alert = alertStatusFromXml(event.payload.rawXml, receivedAtMs);
  const devices = state.devices.map((device) =>
    device.id === event.payload.cameraId
      ? {
          ...device,
          annke: annkeStatusFromAlert(device.annke, alert)
        }
      : device
  );
  const eventState = textForTag(event.payload.rawXml, 'eventState');
  const reviewEvents =
    !eventState || eventState === 'active'
      ? [
          {
            id: event.id,
            cameraId: event.payload.cameraId,
            occurredAtMs: receivedAtMs,
            eventType: alert.eventType,
            eventState,
            targetType: alert.targetType,
            label: recordingEventLabel(alert.targetType, alert.eventType),
            sourceEventId: event.id,
            preferredSegment: preferredSegmentForEvent(
              state.recordings.segments,
              event.payload.cameraId,
              receivedAtMs
            )
          },
          ...state.recordings.events.filter((candidate) => candidate.id !== event.id)
        ].sort((left, right) => right.occurredAtMs - left.occurredAtMs || left.id.localeCompare(right.id))
      : state.recordings.events;

  return withProcessEvent(
    {
      ...state,
      devices,
      recordings: rebuildRecordingState(state.recordings.segments, reviewEvents, devices.length)
    },
    'patrol-annke-events',
    {
      tsMs: event.ts_ms,
      eventType: event.type,
      detail: 'Annke alert stream delivered an event',
      healthOverride: null
    }
  );
}

function withRecordingSegmentObserved(
  state: CameraDiscoveryState,
  event: PatrolEvent<RecordingSegmentObservedPayload>
): CameraDiscoveryState {
  if (event.payload.sizeBytes <= 0) {
    return state;
  }

  const segment = {
    cameraId: event.payload.cameraId,
    role: event.payload.role,
    streamName: event.payload.streamName,
    startMs: event.payload.startMs,
    endMs: event.payload.startMs + event.payload.durationMs,
    durationMs: event.payload.durationMs,
    sizeBytes: event.payload.sizeBytes,
    relativePath: event.payload.relativePath,
    observedAtMs: event.ts_ms
  };
  const segments = [segment, ...state.recordings.segments.filter((candidate) => candidate.relativePath !== segment.relativePath)].sort(
    compareRecordingSegments
  );

  return withProcessEvent(
    {
      ...state,
      recordings: rebuildRecordingState(segments, state.recordings.events, state.devices.length)
    },
    'patrol-recorder',
    {
      tsMs: event.ts_ms,
      eventType: event.type,
      detail: `${event.payload.role} segment recorded for ${event.payload.streamName}`,
      healthOverride: null
    }
  );
}

function withRecordingSegmentExpired(
  state: CameraDiscoveryState,
  event: PatrolEvent<RecordingSegmentExpiredPayload>
): CameraDiscoveryState {
  const segments = state.recordings.segments.filter((segment) => segment.relativePath !== event.payload.relativePath);
  return {
    ...state,
    recordings: rebuildRecordingState(segments, state.recordings.events, state.devices.length)
  };
}

function reduceSystemProcesses(
  cameraEvents: PatrolEvent[],
  systemEvents: PatrolEvent[]
): SystemProcessStatus[] {
  const nowMs = Date.now();
  const latestByProcessId = new Map<
    string,
    {
      tsMs: number;
      eventType: string;
      detail: string | null;
      healthOverride: SystemProcessStatus['health'] | null;
    }
  >();

  for (const event of systemEvents) {
    if (event.type === 'system.process.heartbeat') {
      const heartbeat = event as PatrolEvent<SystemProcessHeartbeatPayload>;
      updateProcessEvent(latestByProcessId, heartbeat.payload.processId, {
        tsMs: heartbeat.ts_ms,
        eventType: heartbeat.type,
        detail: heartbeat.payload.detail,
        healthOverride: null
      });
    }

    if (event.type === 'system.process.exited') {
      const exited = event as PatrolEvent<SystemProcessExitedPayload>;
      updateProcessEvent(latestByProcessId, exited.payload.processId, {
        tsMs: exited.ts_ms,
        eventType: exited.type,
        detail: exited.payload.detail,
        healthOverride: 'error'
      });
    }
  }

  for (const event of cameraEvents) {
    if (event.type === 'go2rtc.streams.observed') {
      const observed = event as PatrolEvent<Go2rtcStreamsObservedPayload>;
      updateProcessEvent(latestByProcessId, 'patrol-go2rtc', {
        tsMs: observed.ts_ms,
        eventType: observed.type,
        detail: observed.payload.rawResult.ok
          ? 'go2rtc API health check responded'
          : observed.payload.rawResult.error ?? 'go2rtc API health check failed',
        healthOverride: observed.payload.rawResult.ok ? null : 'error'
      });
    }

    if (event.type === 'annke.isapi.response.observed') {
      const observed = event as PatrolEvent<AnnkeIsapiResponseObservedPayload>;
      updateProcessEvent(latestByProcessId, 'patrol-annke-events', {
        tsMs: observed.ts_ms,
        eventType: observed.type,
        detail: observed.payload.rawResult.ok
          ? 'Annke ISAPI health check responded'
          : observed.payload.rawResult.error ?? 'Annke ISAPI health check failed',
        healthOverride: observed.payload.rawResult.ok ? null : 'error'
      });
    }

    if (event.type === 'annke.alert_stream.message_received') {
      updateProcessEvent(latestByProcessId, 'patrol-annke-events', {
        tsMs: event.ts_ms,
        eventType: event.type,
        detail: 'Annke alert stream delivered an event',
        healthOverride: null
      });
    }

    if (event.type === 'recording.segment.observed') {
      const observed = event as PatrolEvent<RecordingSegmentObservedPayload>;
      updateProcessEvent(latestByProcessId, 'patrol-recorder', {
        tsMs: observed.ts_ms,
        eventType: observed.type,
        detail: `${observed.payload.role} segment recorded for ${observed.payload.streamName}`,
        healthOverride: null
      });
    }
  }

  return SYSTEM_PROCESS_TASKS.map((task) => {
    const latest = latestByProcessId.get(task.id);
    const stale = latest ? nowMs - latest.tsMs > task.expectedEveryMs : false;
    const health = !latest
      ? 'missing'
      : latest.healthOverride === 'error'
        ? 'error'
        : stale
          ? 'stale'
          : 'ok';

    return {
      id: task.id,
      label: task.label,
      kind: task.kind,
      expectedEveryMs: task.expectedEveryMs,
      lastAliveAtMs: latest?.tsMs ?? null,
      lastEventType: latest?.eventType ?? null,
      health,
      detail: latest?.detail ?? task.detail
    };
  });
}

function buildRecordingState(
  segments: RecordingSegment[],
  alertEvents: Array<PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>>,
  cameraCount: number
): RecordingState {
  const activeAlertEvents = alertEvents
    .filter((event) => {
      const state = textForTag(event.payload.rawXml, 'eventState');
      return !state || state === 'active';
    })
    .sort((a, b) => b.payload.receivedAtMs - a.payload.receivedAtMs || a.id.localeCompare(b.id));

  const events: ReviewableSecurityEvent[] = activeAlertEvents.map((event) => {
    const eventType = textForTag(event.payload.rawXml, 'eventType');
    const eventState = textForTag(event.payload.rawXml, 'eventState');
    const targetType = textForTag(event.payload.rawXml, 'targetType');
    return {
      id: event.id,
      cameraId: event.payload.cameraId,
      occurredAtMs: event.payload.receivedAtMs,
      eventType,
      eventState,
      targetType,
      label: recordingEventLabel(targetType, eventType),
      sourceEventId: event.id,
      preferredSegment: preferredSegmentForEvent(segments, event.payload.cameraId, event.payload.receivedAtMs)
    };
  });

  return {
    segments,
    events,
    storage: {
      cameraCount,
      mainRetentionDays: MAIN_RECORDING_RETENTION_DAYS,
      subRetentionDays: SUB_RECORDING_RETENTION_DAYS,
      mainEstimatedBytes: estimateBytes(cameraCount, MAIN_ESTIMATED_BITS_PER_SECOND, MAIN_RECORDING_RETENTION_DAYS),
      subEstimatedBytes: estimateBytes(cameraCount, SUB_ESTIMATED_BITS_PER_SECOND, SUB_RECORDING_RETENTION_DAYS),
      totalEstimatedBytes:
        estimateBytes(cameraCount, MAIN_ESTIMATED_BITS_PER_SECOND, MAIN_RECORDING_RETENTION_DAYS) +
        estimateBytes(cameraCount, SUB_ESTIMATED_BITS_PER_SECOND, SUB_RECORDING_RETENTION_DAYS),
      observedBytes: segments.reduce((total, segment) => total + segment.sizeBytes, 0)
    }
  };
}

function preferredSegmentForEvent(segments: RecordingSegment[], cameraId: string, occurredAtMs: number) {
  const ageMs = Date.now() - occurredAtMs;
  const preferredRoles: RecordingStreamRole[] =
    ageMs <= MAIN_RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000 ? ['main', 'sub'] : ['sub'];

  for (const role of preferredRoles) {
    const segment = segments.find(
      (candidate) =>
        candidate.cameraId === cameraId &&
        candidate.role === role &&
        occurredAtMs >= candidate.startMs &&
        occurredAtMs <= candidate.endMs
    );
    if (segment) {
      return segment;
    }
  }

  return null;
}

function recordingEventLabel(targetType: string | null, eventType: string | null) {
  if (targetType === 'human') {
    return 'Person';
  }
  if (targetType === 'vehicle') {
    return 'Vehicle';
  }
  if (targetType) {
    return targetType;
  }
  if (eventType === 'VMD') {
    return 'Motion';
  }
  return eventType ?? 'Camera event';
}

function rebuildRecordingState(
  segments: RecordingSegment[],
  events: ReviewableSecurityEvent[],
  cameraCount: number
): RecordingState {
  const sortedSegments = [...segments].sort(compareRecordingSegments);
  const refreshedEvents = events
    .map((event) => ({
      ...event,
      preferredSegment: preferredSegmentForEvent(sortedSegments, event.cameraId, event.occurredAtMs)
    }))
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs || left.id.localeCompare(right.id));

  return {
    segments: sortedSegments,
    events: refreshedEvents,
    storage: {
      cameraCount,
      mainRetentionDays: MAIN_RECORDING_RETENTION_DAYS,
      subRetentionDays: SUB_RECORDING_RETENTION_DAYS,
      mainEstimatedBytes: estimateBytes(cameraCount, MAIN_ESTIMATED_BITS_PER_SECOND, MAIN_RECORDING_RETENTION_DAYS),
      subEstimatedBytes: estimateBytes(cameraCount, SUB_ESTIMATED_BITS_PER_SECOND, SUB_RECORDING_RETENTION_DAYS),
      totalEstimatedBytes:
        estimateBytes(cameraCount, MAIN_ESTIMATED_BITS_PER_SECOND, MAIN_RECORDING_RETENTION_DAYS) +
        estimateBytes(cameraCount, SUB_ESTIMATED_BITS_PER_SECOND, SUB_RECORDING_RETENTION_DAYS),
      observedBytes: sortedSegments.reduce((total, segment) => total + segment.sizeBytes, 0)
    }
  };
}

function compareRecordingSegments(left: RecordingSegment, right: RecordingSegment) {
  return right.startMs - left.startMs || left.relativePath.localeCompare(right.relativePath);
}

function compareDevices(left: DiscoveredCamera, right: DiscoveredCamera) {
  const leftName = left.name ?? left.remoteAddress;
  const rightName = right.name ?? right.remoteAddress;
  return leftName.localeCompare(rightName);
}

function withProcessEvent(
  state: CameraDiscoveryState,
  processId: string,
  event: {
    tsMs: number;
    eventType: string;
    detail: string | null;
    healthOverride: SystemProcessStatus['health'] | null;
  }
): CameraDiscoveryState {
  const task = SYSTEM_PROCESS_TASKS.find((candidate) => candidate.id === processId);
  const existing = state.processes.find((candidate) => candidate.id === processId);
  const nextProcess: SystemProcessStatus = {
    id: processId,
    label: existing?.label ?? task?.label ?? processId,
    kind: existing?.kind ?? task?.kind ?? 'worker',
    expectedEveryMs: existing?.expectedEveryMs ?? task?.expectedEveryMs ?? PROCESS_STALE_AFTER_MS,
    lastAliveAtMs: event.tsMs,
    lastEventType: event.eventType,
    health: event.healthOverride === 'error' ? 'error' : 'ok',
    detail: event.detail ?? existing?.detail ?? task?.detail ?? null
  };
  const found = state.processes.some((candidate) => candidate.id === processId);
  const processes = found
    ? state.processes.map((candidate) => (candidate.id === processId ? nextProcess : candidate))
    : [...state.processes, nextProcess];

  return {
    ...state,
    processes
  };
}

function go2rtcStatusFromConfiguredStreams(
  config: Go2rtcCameraConfig,
  previous: Go2rtcCameraStatus | null
): Go2rtcCameraStatus {
  const main = configuredGo2rtcStreamStatus('main', config.streams.main, previous?.streams.main);
  const sub = configuredGo2rtcStreamStatus('sub', config.streams.sub, previous?.streams.sub);
  return {
    configuredAtMs: config.configuredAtMs,
    observedAtMs: previous?.observedAtMs ?? null,
    apiReachable: previous?.apiReachable ?? null,
    apiBaseUrl: config.apiBaseUrl,
    health: cameraHealth([main, sub], previous?.apiReachable ?? null),
    streams: { main, sub }
  };
}

function configuredGo2rtcStreamStatus(
  _role: Go2rtcStreamRole,
  streamName: string | undefined,
  previous: Go2rtcStreamStatus | undefined
): Go2rtcStreamStatus {
  if (!streamName) {
    return {
      streamName: '',
      configured: false,
      observed: false,
      producerCount: 0,
      consumerCount: 0,
      health: 'offline'
    };
  }

  if (previous && previous.streamName === streamName) {
    return {
      ...previous,
      configured: true
    };
  }

  return {
    streamName,
    configured: true,
    observed: false,
    producerCount: 0,
    consumerCount: 0,
    health: 'configured'
  };
}

function annkeStatusFromIsapiResponse(
  previous: AnnkeCameraAiStatus | null,
  event: PatrolEvent<AnnkeIsapiResponseObservedPayload>
): AnnkeCameraAiStatus {
  const base = previous ?? emptyAnnkeStatus();
  const body = event.payload.rawResult.body ?? '';
  const motionDetection =
    event.payload.path === '/ISAPI/System/Video/inputs/channels/1/motionDetection'
      ? {
          observedAtMs: event.ts_ms,
          ok: event.payload.rawResult.ok,
          enabled: body ? parseBooleanTag(body, 'enabled') : null,
          targetTypes: body ? parseTargetTypes(body) : [],
          sensitivityLevel: body ? parseNumberTag(body, 'sensitivityLevel') : null
        }
      : base.motionDetection;
  const smartCapabilities =
    event.payload.path === '/ISAPI/Smart/capabilities'
      ? {
          observedAtMs: event.ts_ms,
          ok: event.payload.rawResult.ok,
          faceDetect: body ? parseBooleanTag(body, 'isSupportFaceDetect') : null,
          audioDetection: body ? parseBooleanTag(body, 'isSupportAudioDetection') : null,
          sceneChangeDetection: body ? parseBooleanTag(body, 'isSupportSceneChangeDetection') : null
        }
      : base.smartCapabilities;

  return {
    observedAtMs: latestTimestamp([motionDetection.observedAtMs, smartCapabilities.observedAtMs, base.lastAlert?.receivedAtMs]),
    health: annkeHealth({
      motionOk: motionDetection.ok,
      motionEnabled: motionDetection.enabled,
      targetTypes: motionDetection.targetTypes,
      alertState: base.lastAlert?.eventState ?? null,
      hasAlert: Boolean(base.lastAlert)
    }),
    motionDetection,
    smartCapabilities,
    lastAlert: base.lastAlert
  };
}

function annkeStatusFromAlert(
  previous: AnnkeCameraAiStatus | null,
  alert: NonNullable<AnnkeCameraAiStatus['lastAlert']>
): AnnkeCameraAiStatus {
  const base = previous ?? emptyAnnkeStatus();
  return {
    ...base,
    observedAtMs: latestTimestamp([base.motionDetection.observedAtMs, base.smartCapabilities.observedAtMs, alert.receivedAtMs]),
    health: annkeHealth({
      motionOk: base.motionDetection.ok,
      motionEnabled: base.motionDetection.enabled,
      targetTypes: base.motionDetection.targetTypes,
      alertState: alert.eventState,
      hasAlert: true
    }),
    lastAlert: alert
  };
}

function alertStatusFromXml(xml: string, receivedAtMs: number): NonNullable<AnnkeCameraAiStatus['lastAlert']> {
  return {
    receivedAtMs,
    eventType: textForTag(xml, 'eventType'),
    eventState: textForTag(xml, 'eventState'),
    eventDescription: textForTag(xml, 'eventDescription'),
    targetType: textForTag(xml, 'targetType'),
    channelName: textForTag(xml, 'channelName'),
    cameraDateTime: textForTag(xml, 'dateTime')
  };
}

function emptyAnnkeStatus(): AnnkeCameraAiStatus {
  return {
    observedAtMs: null,
    health: 'unknown',
    motionDetection: {
      observedAtMs: null,
      ok: null,
      enabled: null,
      targetTypes: [],
      sensitivityLevel: null
    },
    smartCapabilities: {
      observedAtMs: null,
      ok: null,
      faceDetect: null,
      audioDetection: null,
      sceneChangeDetection: null
    },
    lastAlert: null
  };
}

function estimateBytes(cameraCount: number, bitsPerSecond: number, days: number) {
  return Math.round((cameraCount * bitsPerSecond * days * 24 * 60 * 60) / 8);
}

function updateProcessEvent(
  latestByProcessId: Map<
    string,
    {
      tsMs: number;
      eventType: string;
      detail: string | null;
      healthOverride: SystemProcessStatus['health'] | null;
    }
  >,
  processId: string,
  event: {
    tsMs: number;
    eventType: string;
    detail: string | null;
    healthOverride: SystemProcessStatus['health'] | null;
  }
) {
  const existing = latestByProcessId.get(processId);
  if (!existing || event.tsMs >= existing.tsMs) {
    latestByProcessId.set(processId, event);
  }
}

function parseProbeResponse(response: RawProbeResponse): DiscoveredCamera {
  const xaddrs = splitWords(textForTag(response.body, 'XAddrs'));
  const scopes = splitWords(textForTag(response.body, 'Scopes')).map(decodeScope);
  const types = splitWords(textForTag(response.body, 'Types'));
  const endpoint = textForTag(response.body, 'Address');
  const id = endpoint ?? xaddrs[0] ?? `udp:${response.remoteAddress}`;

  return {
    id,
    endpoint,
    remoteAddress: response.remoteAddress,
    lastSeenAtMs: response.receivedAtMs,
    xaddrs,
    setupUrl: setupUrl(response.remoteAddress),
    scopes,
    types,
    name: scopeValue(scopes, '/name/'),
    hardware: scopeValue(scopes, '/hardware/'),
    location: scopeValue(scopes, '/location/'),
    vendorHint: inferVendor(scopes, xaddrs),
    streams: streamNames(scopes, response.remoteAddress, id),
    credentials: null,
    go2rtc: null,
    annke: null
  };
}

interface AnnkeCameraAiReducerState {
  deviceInfo?: PatrolEvent<AnnkeIsapiResponseObservedPayload>;
  motionDetection?: PatrolEvent<AnnkeIsapiResponseObservedPayload>;
  smartCapabilities?: PatrolEvent<AnnkeIsapiResponseObservedPayload>;
  lastAlert?: PatrolEvent<AnnkeAlertStreamMessageReceivedPayload>;
}

function buildAnnkeCameraAiStatus(state: AnnkeCameraAiReducerState | null): AnnkeCameraAiStatus | null {
  if (!state) {
    return null;
  }

  const motion = state.motionDetection;
  const smart = state.smartCapabilities;
  const alert = state.lastAlert;
  const motionXml = motion?.payload.rawResult.body ?? null;
  const smartXml = smart?.payload.rawResult.body ?? null;
  const alertXml = alert?.payload.rawXml ?? null;
  const alertState = alertXml ? textForTag(alertXml, 'eventState') : null;
  const motionEnabled = motionXml ? parseBooleanTag(motionXml, 'enabled') : null;
  const targetTypes = motionXml ? parseTargetTypes(motionXml) : [];
  const health = annkeHealth({
    motionOk: motion?.payload.rawResult.ok ?? null,
    motionEnabled,
    targetTypes,
    alertState,
    hasAlert: Boolean(alert)
  });

  return {
    observedAtMs: latestTimestamp([motion?.ts_ms, smart?.ts_ms, alert?.payload.receivedAtMs]),
    health,
    motionDetection: {
      observedAtMs: motion?.ts_ms ?? null,
      ok: motion?.payload.rawResult.ok ?? null,
      enabled: motionEnabled,
      targetTypes,
      sensitivityLevel: motionXml ? parseNumberTag(motionXml, 'sensitivityLevel') : null
    },
    smartCapabilities: {
      observedAtMs: smart?.ts_ms ?? null,
      ok: smart?.payload.rawResult.ok ?? null,
      faceDetect: smartXml ? parseBooleanTag(smartXml, 'isSupportFaceDetect') : null,
      audioDetection: smartXml ? parseBooleanTag(smartXml, 'isSupportAudioDetection') : null,
      sceneChangeDetection: smartXml ? parseBooleanTag(smartXml, 'isSupportSceneChangeDetection') : null
    },
    lastAlert: alert
      ? {
          receivedAtMs: alert.payload.receivedAtMs,
          eventType: textForTag(alertXml ?? '', 'eventType'),
          eventState: alertState,
          eventDescription: textForTag(alertXml ?? '', 'eventDescription'),
          targetType: textForTag(alertXml ?? '', 'targetType'),
          channelName: textForTag(alertXml ?? '', 'channelName'),
          cameraDateTime: textForTag(alertXml ?? '', 'dateTime')
        }
      : null
  };
}

function annkeHealth(input: {
  motionOk: boolean | null;
  motionEnabled: boolean | null;
  targetTypes: string[];
  alertState: string | null;
  hasAlert: boolean;
}): AnnkeAiHealth {
  if (input.motionOk === false) {
    return 'error';
  }

  if (input.alertState === 'active') {
    return 'alert_active';
  }

  if (input.hasAlert) {
    return 'alert_idle';
  }

  if (input.motionEnabled && input.targetTypes.length > 0) {
    return 'motion_enabled';
  }

  return 'unknown';
}

function isAnnkeAiAlert(xml: string) {
  return textForTag(xml, 'eventType') === 'VMD' || Boolean(textForTag(xml, 'targetType'));
}

function latestTimestamp(values: Array<number | null | undefined>) {
  const timestamps = values.filter((value): value is number => typeof value === 'number');
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function parseTargetTypes(xml: string) {
  const rawTargetTypes = textForTag(xml, 'targetType') ?? tagAttribute(xml, 'targetType', 'opt');
  return rawTargetTypes ? rawTargetTypes.split(',').map((value) => value.trim()).filter(Boolean) : [];
}

function parseBooleanTag(xml: string, tagName: string) {
  const value = textForTag(xml, tagName);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

function parseNumberTag(xml: string, tagName: string) {
  const value = textForTag(xml, tagName);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tagAttribute(xml: string, tagName: string, attributeName: string) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?\\s${attributeName}="([^"]*)"[^>]*>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

interface Go2rtcCameraConfig {
  configuredAtMs: number;
  apiBaseUrl: string;
  streams: Partial<Record<Go2rtcStreamRole, string>>;
}

interface Go2rtcObservedStream {
  producerCount: number;
  consumerCount: number;
}

function buildGo2rtcCameraStatus(
  config: Go2rtcCameraConfig | null,
  latestObservation: PatrolEvent<Go2rtcStreamsObservedPayload> | null,
  observedStreams: Map<string, Go2rtcObservedStream>
): Go2rtcCameraStatus | null {
  if (!config) {
    return null;
  }

  const apiReachable = latestObservation ? latestObservation.payload.rawResult.ok : null;
  const main = buildGo2rtcStreamStatus('main', config, latestObservation, observedStreams);
  const sub = buildGo2rtcStreamStatus('sub', config, latestObservation, observedStreams);
  const health = cameraHealth([main, sub], apiReachable);

  return {
    configuredAtMs: config.configuredAtMs,
    observedAtMs: latestObservation?.ts_ms ?? null,
    apiReachable,
    apiBaseUrl: config.apiBaseUrl,
    health,
    streams: { main, sub }
  };
}

function buildGo2rtcStreamStatus(
  role: Go2rtcStreamRole,
  config: Go2rtcCameraConfig,
  latestObservation: PatrolEvent<Go2rtcStreamsObservedPayload> | null,
  observedStreams: Map<string, Go2rtcObservedStream>
): Go2rtcStreamStatus {
  const streamName = config.streams[role] ?? '';
  const observed = streamName ? observedStreams.get(streamName) : undefined;
  const configured = Boolean(streamName);
  let health: Go2rtcCameraHealth = configured ? 'configured' : 'offline';

  if (latestObservation) {
    if (!latestObservation.payload.rawResult.ok || !observed) {
      health = 'offline';
    } else if (observed.consumerCount > 0) {
      health = 'streaming';
    } else if (observed.producerCount > 0) {
      health = 'ready';
    } else {
      health = 'offline';
    }
  }

  return {
    streamName,
    configured,
    observed: Boolean(observed),
    producerCount: observed?.producerCount ?? 0,
    consumerCount: observed?.consumerCount ?? 0,
    health
  };
}

function cameraHealth(
  streams: Go2rtcStreamStatus[],
  apiReachable: Go2rtcCameraStatus['apiReachable']
): Go2rtcCameraHealth {
  if (apiReachable === false) {
    return 'offline';
  }

  if (streams.some((stream) => stream.health === 'streaming')) {
    return 'streaming';
  }

  if (streams.every((stream) => stream.health === 'ready')) {
    return 'ready';
  }

  if (streams.some((stream) => stream.health === 'ready' || stream.health === 'streaming')) {
    return 'partial';
  }

  if (streams.every((stream) => stream.health === 'configured')) {
    return 'configured';
  }

  return 'offline';
}

function parseGo2rtcStreams(body: string | null) {
  const observedStreams = new Map<string, Go2rtcObservedStream>();
  if (!body) {
    return observedStreams;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return observedStreams;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return observedStreams;
  }

  for (const [streamName, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const record = value as { producers?: unknown; consumers?: unknown };
    observedStreams.set(streamName, {
      producerCount: Array.isArray(record.producers) ? record.producers.length : 0,
      consumerCount: Array.isArray(record.consumers) ? record.consumers.length : 0
    });
  }

  return observedStreams;
}

function streamNames(scopes: string[], remoteAddress: string, id: string) {
  const rawName = scopeValue(scopes, '/name/') ?? scopeValue(scopes, '/hardware/') ?? remoteAddress ?? id;
  const baseName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const streamBase = baseName || `camera_${Math.abs(hashString(id))}`;
  return {
    main: `${streamBase}_main`,
    sub: `${streamBase}_sub`
  };
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function textForTag(xml: string, tagName: string) {
  const match = xml.match(
    new RegExp(`<[^:>/]*:?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</[^:>/]*:?${tagName}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : null;
}

function splitWords(value: string | null) {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function decodeScope(scope: string) {
  try {
    return decodeURIComponent(scope);
  } catch {
    return scope;
  }
}

function scopeValue(scopes: string[], marker: string) {
  const match = scopes.find((scope) => scope.includes(marker));
  if (!match) {
    return null;
  }

  const [, value] = match.split(marker);
  return value ? value.replace(/\+/g, ' ') : null;
}

function inferVendor(scopes: string[], xaddrs: string[]) {
  const haystack = [...scopes, ...xaddrs].join(' ').toLowerCase();
  if (haystack.includes('annke')) {
    return 'annke';
  }
  if (haystack.includes('hikvision')) {
    return 'hikvision';
  }
  return null;
}

function setupUrl(remoteAddress: string) {
  return remoteAddress.includes(':') ? `http://[${remoteAddress}]` : `http://${remoteAddress}`;
}

function dedupeDevices(devices: DiscoveredCamera[]) {
  const byId = new Map<string, DiscoveredCamera>();
  for (const device of devices) {
    byId.set(device.id, device);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const left = a.name ?? a.remoteAddress;
    const right = b.name ?? b.remoteAddress;
    return left.localeCompare(right);
  });
}

function decodeXml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
