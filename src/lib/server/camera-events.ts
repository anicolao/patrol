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
  RawProbeResponse
} from '$lib/cameras/discovery';
import { appendEvent, readEvents, type PatrolEvent } from '$lib/server/event-store';

const CAMERA_STREAM = 'cameras';
const DISCOVERY_STALE_AFTER_MS = 60 * 60 * 1000;

interface DiscoveryInitiatedPayload {
  protocol: 'onvif-ws-discovery';
}

interface DiscoveryCompletedPayload {
  rawResult: CameraDiscoveryRawResult;
}

interface CameraCredentialsSavedPayload {
  cameraId: string;
  host: string;
  secretIds: {
    username: string;
    password: string;
  };
  secretStoredAtMs: number;
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

export async function appendDiscoveryInitiated(runId: string) {
  return await appendEvent<DiscoveryInitiatedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.initiated',
    source: 'patrol-web',
    correlation_id: runId,
    payload: {
      protocol: 'onvif-ws-discovery'
    }
  });
}

export async function appendDiscoveryCompleted(runId: string, rawResult: CameraDiscoveryRawResult) {
  return await appendEvent<DiscoveryCompletedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.completed',
    source: 'patrol-discovery',
    correlation_id: runId,
    payload: {
      rawResult
    }
  });
}

export async function appendCameraCredentialsSaved(payload: CameraCredentialsSavedPayload) {
  return await appendEvent<CameraCredentialsSavedPayload>(CAMERA_STREAM, {
    type: 'camera.credentials.saved',
    source: 'patrol-web',
    payload
  });
}

export async function appendGo2rtcObservationRequested(payload: Go2rtcObservationRequestedPayload) {
  return await appendEvent<Go2rtcObservationRequestedPayload>(CAMERA_STREAM, {
    type: 'go2rtc.observation.requested',
    source: 'patrol-web',
    payload
  });
}

export async function appendGo2rtcStreamsObserved(payload: Go2rtcStreamsObservedPayload) {
  return await appendEvent<Go2rtcStreamsObservedPayload>(CAMERA_STREAM, {
    type: 'go2rtc.streams.observed',
    source: 'patrol-go2rtc-observer',
    payload
  });
}

export async function appendAnnkeAiObservationRequested(payload: AnnkeAiObservationRequestedPayload) {
  return await appendEvent<AnnkeAiObservationRequestedPayload>(CAMERA_STREAM, {
    type: 'annke.ai.observation.requested',
    source: 'patrol-web',
    payload
  });
}

export async function appendAnnkeIsapiResponseObserved(payload: AnnkeIsapiResponseObservedPayload) {
  return await appendEvent<AnnkeIsapiResponseObservedPayload>(CAMERA_STREAM, {
    type: 'annke.isapi.response.observed',
    source: 'patrol-annke-observer',
    payload
  });
}

export async function appendAnnkeAlertStreamMessageReceived(
  payload: AnnkeAlertStreamMessageReceivedPayload
) {
  return await appendEvent<AnnkeAlertStreamMessageReceivedPayload>(CAMERA_STREAM, {
    type: 'annke.alert_stream.message_received',
    source: 'patrol-annke-events',
    payload
  });
}

export async function currentCameraDiscoveryState(): Promise<CameraDiscoveryState> {
  return reduceCameraDiscoveryEvents(await readEvents(CAMERA_STREAM));
}

export function reduceCameraDiscoveryEvents(events: PatrolEvent[]): CameraDiscoveryState {
  const devicesById = new Map<string, DiscoveredCamera>();
  const credentialsByCameraId = new Map<string, DiscoveredCamera['credentials']>();
  const go2rtcConfigsByCameraId = new Map<string, Go2rtcCameraConfig>();
  const annkeStateByCameraId = new Map<string, AnnkeCameraAiReducerState>();
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
      }
      annkeStateByCameraId.set(message.payload.cameraId, state);
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
      devices: [],
      errors: [],
      lastDiscovery: null
    };
  }

  const rawResult = latestCompleted.payload.rawResult;
  return {
    staleAfterMs: DISCOVERY_STALE_AFTER_MS,
    devices: Array.from(devicesById.values())
      .filter((device) => device.credentials || nowMs - device.lastSeenAtMs <= DISCOVERY_STALE_AFTER_MS)
      .sort((a, b) => {
        const left = a.name ?? a.remoteAddress;
        const right = b.name ?? b.remoteAddress;
        return left.localeCompare(right);
      }),
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
