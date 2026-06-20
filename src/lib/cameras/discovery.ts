export interface DiscoveredCamera {
  id: string;
  endpoint: string | null;
  remoteAddress: string;
  lastSeenAtMs: number;
  xaddrs: string[];
  setupUrl: string;
  scopes: string[];
  types: string[];
  name: string | null;
  hardware: string | null;
  location: string | null;
  vendorHint: string | null;
  streams: {
    main: string;
    sub: string;
  };
  credentials: {
    savedAtMs: number;
    usernameSecretId: string;
    passwordSecretId: string;
  } | null;
  controls: CameraControlStatus;
  go2rtc: Go2rtcCameraStatus | null;
  annke: AnnkeCameraAiStatus | null;
}

export interface CameraControlStatus {
  ptz: {
    supported: boolean;
    continuous: boolean;
  };
  supplementLight: {
    supported: boolean;
    modes: string[];
  };
  inferredFrom: string | null;
}

export type RecordingStreamRole = 'main' | 'sub';

export interface RecordingSegment {
  cameraId: string;
  role: RecordingStreamRole;
  streamName: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  sizeBytes: number;
  relativePath: string;
  observedAtMs: number;
}

export interface ReviewableSecurityEvent {
  id: string;
  cameraId: string;
  occurredAtMs: number;
  eventType: string | null;
  eventState: string | null;
  targetType: string | null;
  label: string;
  sourceEventId: string;
  preferredSegment: RecordingSegment | null;
}

export interface RecordingStorageEstimate {
  cameraCount: number;
  mainRetentionDays: number;
  subRetentionDays: number;
  mainEstimatedBytes: number;
  subEstimatedBytes: number;
  totalEstimatedBytes: number;
  observedBytes: number;
}

export interface RecordingState {
  segments: RecordingSegment[];
  events: ReviewableSecurityEvent[];
  storage: RecordingStorageEstimate;
}

export interface PersonCropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersonRecognitionEmbedding {
  model: string;
  dimensions: number;
  vector: number[];
}

export interface PersonRecognitionSample {
  id: string;
  cameraId: string;
  sourceEventId: string;
  occurredAtMs: number;
  status: 'analyzed' | 'failed';
  cropRelativePath: string | null;
  cropUrl: string | null;
  cropBox: PersonCropBox | null;
  cropMethod: string | null;
  cropVersion: string | null;
  sourceSegmentRelativePath: string | null;
  sourceOffsetMs: number | null;
  embedding: PersonRecognitionEmbedding | null;
  label: string | null;
  suggestedLabel: string | null;
  suggestedScore: number | null;
  error: string | null;
  analyzedAtMs: number | null;
  labeledAtMs: number | null;
  dismissedAtMs: number | null;
}

export interface PersonRecognitionState {
  samples: PersonRecognitionSample[];
  labels: string[];
  unlabeledCount: number;
  labeledCount: number;
}

export type AnnkeAiHealth = 'unknown' | 'motion_enabled' | 'alert_idle' | 'alert_active' | 'error';

export interface AnnkeCameraAiStatus {
  observedAtMs: number | null;
  health: AnnkeAiHealth;
  motionDetection: {
    observedAtMs: number | null;
    ok: boolean | null;
    enabled: boolean | null;
    targetTypes: string[];
    sensitivityLevel: number | null;
  };
  smartCapabilities: {
    observedAtMs: number | null;
    ok: boolean | null;
    faceDetect: boolean | null;
    audioDetection: boolean | null;
    sceneChangeDetection: boolean | null;
  };
  lastAlert: {
    receivedAtMs: number;
    eventType: string | null;
    eventState: string | null;
    eventDescription: string | null;
    targetType: string | null;
    channelName: string | null;
    cameraDateTime: string | null;
  } | null;
}

export type Go2rtcStreamRole = 'main' | 'sub';

export type Go2rtcCameraHealth = 'configured' | 'ready' | 'streaming' | 'partial' | 'offline';

export interface Go2rtcStreamStatus {
  streamName: string;
  configured: boolean;
  observed: boolean;
  producerCount: number;
  consumerCount: number;
  health: Go2rtcCameraHealth;
}

export interface Go2rtcCameraStatus {
  configuredAtMs: number | null;
  observedAtMs: number | null;
  apiReachable: boolean | null;
  apiBaseUrl: string | null;
  health: Go2rtcCameraHealth;
  streams: Record<Go2rtcStreamRole, Go2rtcStreamStatus>;
}

export type SystemProcessHealth = 'ok' | 'stale' | 'missing' | 'error';
export type SystemProcessKind = 'server' | 'worker';

export interface SystemProcessStatus {
  id: string;
  label: string;
  kind: SystemProcessKind;
  expectedEveryMs: number;
  lastAliveAtMs: number | null;
  lastEventType: string | null;
  gitRevision: string | null;
  health: SystemProcessHealth;
  detail: string | null;
}

export interface RawProbeResponse {
  remoteAddress: string;
  receivedAtMs: number;
  body: string;
}

export interface CameraDiscoveryRawResult {
  protocol: 'onvif-ws-discovery';
  startedAtMs: number;
  durationMs: number;
  responses: RawProbeResponse[];
  errors: string[];
}

export interface CameraDiscoveryState {
  staleAfterMs: number;
  processes: SystemProcessStatus[];
  devices: DiscoveredCamera[];
  recordings: RecordingState;
  people: PersonRecognitionState;
  errors: string[];
  lastDiscovery: {
    runId: string;
    protocol: 'onvif-ws-discovery';
    startedAtMs: number;
    durationMs: number;
    completedAtMs: number;
  } | null;
}
