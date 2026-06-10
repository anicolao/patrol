export interface DiscoveredCamera {
  id: string;
  endpoint: string | null;
  remoteAddress: string;
  xaddrs: string[];
  setupUrl: string;
  scopes: string[];
  types: string[];
  name: string | null;
  hardware: string | null;
  location: string | null;
  vendorHint: string | null;
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
  devices: DiscoveredCamera[];
  errors: string[];
  lastDiscovery: {
    runId: string;
    protocol: 'onvif-ws-discovery';
    startedAtMs: number;
    durationMs: number;
    completedAtMs: number;
  } | null;
}
