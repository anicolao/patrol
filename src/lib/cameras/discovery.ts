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

export interface CameraDiscoveryResult {
  protocol: 'onvif-ws-discovery';
  startedAtMs: number;
  durationMs: number;
  devices: DiscoveredCamera[];
  errors: string[];
}
