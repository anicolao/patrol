<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import type {
    CameraDiscoveryState,
    DiscoveredCamera,
    ReviewableSecurityEvent
  } from '$lib/cameras/discovery';
  import { reduceCameraStateSnapshotEvent } from '$lib/cameras/state-reducer';
  import type { CameraStateSnapshot, EventCursor, PatrolEvent, StreamedPatrolEvent } from '$lib/events';

  type Tab = 'cameras' | 'history' | 'settings' | 'health';
  type LiveEventConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
  type LiveEventEntry = {
    receivedAtMs: number;
    messageType: string;
    stream: string | null;
    eventType: string | null;
    source: string | null;
    summary: string;
  };

  const liveEventPort = '5186';
  const localStateCacheKey = 'patrol.camera_state.v2';

  let cameraSnapshot: CameraStateSnapshot | null = null;
  let error: string | null = null;
  let discovering = false;
  let observingGo2rtc = false;
  let observingAnnkeAi = false;
  let hydrated = false;
  let activeTab: Tab = 'cameras';
  let selectedReviewEventId: string | null = null;
  let nowMs = Date.now();
  let credentialStatus: Record<string, { state: 'saving' | 'saved' | 'error'; message: string }> = {};
  let liveEventStatus: LiveEventConnectionState = 'connecting';
  let liveEventError: string | null = null;
  let liveEventUrl = '';
  let liveEvents: LiveEventEntry[] = [];
  let stateReloadInFlight = false;
  let stateReloadQueued = false;
  let configuredCameras: DiscoveredCamera[] = [];
  let processGreenCount = 0;
  let allProcessesGreen = false;
  let selectedReviewEvent: ReviewableSecurityEvent | null = null;
  let selectedRecordingSource: string | null = null;
  let selectedRecordingQuality = 'no recording';
  $: discoveryState = cameraSnapshot?.state ?? null;
  $: configuredCameras = (discoveryState?.devices ?? []).filter((camera) => camera.credentials);
  $: processGreenCount = (discoveryState?.processes ?? []).filter((process) => process.health === 'ok').length;
  $: allProcessesGreen =
    (discoveryState?.processes.length ?? 0) > 0 &&
    (discoveryState?.processes ?? []).every((process) => process.health === 'ok');
  $: selectedReviewEvent =
    (discoveryState?.recordings.events ?? []).find((event) => event.id === selectedReviewEventId) ??
    (discoveryState?.recordings.events ?? []).find((event) => event.preferredSegment) ??
    null;
  $: selectedRecordingSource = selectedReviewEvent ? recordingSource(selectedReviewEvent) : null;
  $: selectedRecordingQuality = selectedReviewEvent ? recordingQualityLabel(selectedReviewEvent) : 'no recording';

  onMount(() => {
    hydrated = true;
    const loadedCachedState = loadCachedDiscoveryState();
    let stopEventSocket: (() => void) | null = null;
    let stopped = false;
    const bootstrap = loadedCachedState ? Promise.resolve() : loadDiscoveryState();
    void bootstrap.finally(() => {
      if (!stopped) {
        stopEventSocket = connectEventSocket();
      }
    });
    void sendSystemHeartbeat();
    const interval = window.setInterval(() => {
      nowMs = Date.now();
    }, 60000);
    const heartbeatInterval = window.setInterval(() => {
      void sendSystemHeartbeat();
    }, 30000);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.clearInterval(heartbeatInterval);
      stopEventSocket?.();
    };
  });

  async function loadDiscoveryState(fresh = false) {
    if (stateReloadInFlight) {
      stateReloadQueued = true;
      return;
    }

    stateReloadInFlight = true;
    try {
      const response = await fetch(fresh ? '/api/state?fresh=1' : '/api/state');
      if (!response.ok) {
        throw new Error(`State replay failed with HTTP ${response.status}`);
      }
      setCameraSnapshotFromPayload(await response.json());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      stateReloadInFlight = false;
      if (stateReloadQueued) {
        stateReloadQueued = false;
        void loadDiscoveryState(true);
      }
    }
  }

  async function discoverCameras() {
    discovering = true;
    error = null;

    try {
      const response = await fetch('/api/cameras/discover', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Discovery failed with HTTP ${response.status}`);
      }
      setCameraSnapshotFromPayload(await response.json());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      discovering = false;
    }
  }

  async function observeGo2rtc() {
    observingGo2rtc = true;
    error = null;

    try {
      const response = await fetch('/api/go2rtc/observe', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`go2rtc observation failed with HTTP ${response.status}`);
      }
      setCameraSnapshotFromPayload(await response.json());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      observingGo2rtc = false;
    }
  }

  async function observeAnnkeAi() {
    observingAnnkeAi = true;
    error = null;

    try {
      const response = await fetch('/api/annke/observe', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Annke AI observation failed with HTTP ${response.status}`);
      }
      setCameraSnapshotFromPayload(await response.json());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      observingAnnkeAi = false;
    }
  }

  async function sendSystemHeartbeat() {
    try {
      const response = await fetch('/api/system/heartbeat?event=1', { method: 'POST' });
      if (response.ok && cameraSnapshot) {
        const streamedEvent = await response.json();
        if (isStreamedPatrolEvent(streamedEvent)) {
          setCameraSnapshot(reduceCameraStateSnapshotEvent(cameraSnapshot, streamedEvent));
        }
      }
    } catch {
      // The process dashboard will show stale/missing state once the API stops responding.
    }
  }

  function connectEventSocket() {
    if (!browser) {
      return null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname || 'localhost';
    liveEventUrl = cameraSnapshot?.cursor
      ? `${protocol}//${host}:${liveEventPort}/ws/events?${new URLSearchParams({
          after_ts_ms: String(cameraSnapshot.cursor.ts_ms),
          after_id: cameraSnapshot.cursor.id
        }).toString()}`
      : `${protocol}//${host}:${liveEventPort}/ws/events`;
    liveEventStatus = 'connecting';
    liveEventError = null;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const openSocket = () => {
      socket = new WebSocket(liveEventUrl);

      socket.addEventListener('open', () => {
        liveEventStatus = 'connected';
        liveEventError = null;
      });

      socket.addEventListener('message', (event) => {
        liveEventStatus = 'connected';
        liveEventError = null;
        const liveEvent = summarizeLiveEvent(event.data);
        liveEvents = [liveEvent, ...liveEvents].slice(0, 30);
        const streamedEvent = parseStreamedEvent(event.data);
        if (streamedEvent && cameraSnapshot) {
          setCameraSnapshot(reduceCameraStateSnapshotEvent(cameraSnapshot, streamedEvent));
        }
      });

      socket.addEventListener('close', () => {
        if (stopped) {
          return;
        }
        liveEventStatus = 'disconnected';
        reconnectTimer = window.setTimeout(openSocket, 2000);
      });

      socket.addEventListener('error', () => {
        liveEventStatus = 'error';
        liveEventError = 'Live event websocket is not reachable.';
      });
    };

    openSocket();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }

  function summarizeLiveEvent(data: string): LiveEventEntry {
    const receivedAtMs = Date.now();

    try {
      const message = JSON.parse(data) as {
        type?: string;
        stream?: string;
        event?: {
          type?: string;
          source?: string;
          payload?: Record<string, unknown>;
        };
      };
      const eventType = message.event?.type ?? null;
      const source = message.event?.source ?? null;

      return {
        receivedAtMs,
        messageType: message.type ?? 'unknown',
        stream: message.stream ?? null,
        eventType,
        source,
        summary: summarizeLiveEventPayload(message.event?.payload)
      };
    } catch {
      return {
        receivedAtMs,
        messageType: 'unparseable',
        stream: null,
        eventType: null,
        source: null,
        summary: data.slice(0, 180)
      };
    }
  }

  function parseStreamedEvent(data: string): StreamedPatrolEvent | null {
    try {
      const message = JSON.parse(data) as { type?: string } & Partial<StreamedPatrolEvent>;
      if (message.type !== 'patrol.event.appended' || !isStreamedPatrolEvent(message)) {
        return null;
      }
      return {
        stream: message.stream,
        event: message.event
      };
    } catch {
      return null;
    }
  }

  function isStreamedPatrolEvent(value: unknown): value is StreamedPatrolEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Partial<StreamedPatrolEvent>;
    return typeof candidate.stream === 'string' && isPatrolEvent(candidate.event);
  }

  function isPatrolEvent(value: unknown): value is PatrolEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const event = value as Partial<PatrolEvent>;
    return (
      typeof event.id === 'string' &&
      typeof event.ts_ms === 'number' &&
      typeof event.type === 'string' &&
      typeof event.source === 'string'
    );
  }

  function setCameraSnapshotFromPayload(payload: unknown) {
    if (isCameraStateSnapshot(payload)) {
      setCameraSnapshot(payload);
      return;
    }

    setCameraSnapshot({
      state: payload as CameraDiscoveryState,
      cursor: cameraSnapshot?.cursor ?? null,
      cachedAtMs: Date.now()
    });
  }

  function setCameraSnapshot(snapshot: CameraStateSnapshot) {
    cameraSnapshot = snapshot;
    persistCameraSnapshot(snapshot);
  }

  function loadCachedDiscoveryState() {
    if (!browser) {
      return false;
    }

    try {
      const rawCache = window.localStorage.getItem(localStateCacheKey);
      if (!rawCache) {
        return false;
      }
      const snapshot = JSON.parse(rawCache) as CameraStateSnapshot;
      if (!isCameraStateSnapshot(snapshot)) {
        window.localStorage.removeItem(localStateCacheKey);
        return false;
      }
      cameraSnapshot = snapshot;
      return true;
    } catch {
      window.localStorage.removeItem(localStateCacheKey);
      return false;
    }
  }

  function persistCameraSnapshot(snapshot: CameraStateSnapshot) {
    if (!browser) {
      return;
    }

    try {
      window.localStorage.setItem(localStateCacheKey, JSON.stringify(snapshot));
    } catch {
      // Browser storage is an optimization; the server state endpoint remains authoritative.
    }
  }

  function isCameraStateSnapshot(value: unknown): value is CameraStateSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Partial<CameraStateSnapshot>;
    return Boolean(candidate.state) && typeof candidate.cachedAtMs === 'number' && isEventCursorOrNull(candidate.cursor);
  }

  function isEventCursorOrNull(value: unknown): value is EventCursor | null {
    if (value === null) {
      return true;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const cursor = value as Partial<EventCursor>;
    return typeof cursor.ts_ms === 'number' && typeof cursor.id === 'string';
  }

  function summarizeLiveEventPayload(payload: Record<string, unknown> | undefined) {
    if (!payload) {
      return 'connection message';
    }

    const path = typeof payload.path === 'string' ? payload.path : null;
    if (path) {
      return path;
    }

    const rawXml = typeof payload.rawXml === 'string' ? payload.rawXml : null;
    if (rawXml) {
      const eventType = xmlTag(rawXml, 'eventType');
      const eventState = xmlTag(rawXml, 'eventState');
      const targetType = xmlTag(rawXml, 'targetType');
      return [eventType, targetType, eventState].filter(Boolean).join(' ') || 'Annke alert message';
    }

    const cameraId = typeof payload.cameraId === 'string' ? payload.cameraId : null;
    if (cameraId) {
      return cameraId;
    }

    const processId = typeof payload.processId === 'string' ? payload.processId : null;
    if (processId) {
      return processId;
    }

    return 'event payload received';
  }

  function xmlTag(xml: string, tag: string) {
    const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
    return match?.[1] ?? null;
  }

  function displayName(camera: DiscoveredCamera) {
    return camera.name ?? camera.hardware ?? camera.remoteAddress;
  }

  function cameraPath(camera: DiscoveredCamera) {
    return `/cameras/${encodeURIComponent(camera.id)}`;
  }

  function cameraById(cameraId: string) {
    return discoveryState?.devices.find((camera) => camera.id === cameraId) ?? null;
  }

  function go2rtcStreamPath(camera: DiscoveredCamera, stream: 'main' | 'sub') {
    const baseUrl = browser ? `${window.location.protocol}//${window.location.hostname}:1984` : 'http://127.0.0.1:1984';
    const params = new URLSearchParams({
      src: camera.streams[stream],
      mode: 'webrtc,mse,hls',
      width: '100%',
      background: 'false'
    });
    return `${baseUrl}/stream.html?${params.toString()}`;
  }

  function timeAgo(tsMs: number, currentMs: number) {
    const ageSeconds = Math.max(0, Math.floor((currentMs - tsMs) / 1000));
    if (ageSeconds < 60) {
      return `${ageSeconds} second${ageSeconds === 1 ? '' : 's'}`;
    }

    const ageMinutes = Math.floor(ageSeconds / 60);
    if (ageMinutes < 60) {
      return `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'}`;
    }

    const ageHours = Math.floor(ageMinutes / 60);
    return `${ageHours} hour${ageHours === 1 ? '' : 's'}`;
  }

  function formatWindow(ms: number) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    if (hours >= 1) {
      return `${hours}h`;
    }

    const minutes = Math.floor(ms / (60 * 1000));
    return `${minutes}m`;
  }

  function healthLabel(health: string) {
    switch (health) {
      case 'streaming':
        return 'streaming';
      case 'ready':
        return 'ready';
      case 'partial':
        return 'partially ready';
      case 'offline':
        return 'offline';
      default:
        return 'configured';
    }
  }

  function annkeHealthLabel(health: string) {
    switch (health) {
      case 'alert_active':
        return 'alert active';
      case 'alert_idle':
        return 'alert idle';
      case 'motion_enabled':
        return 'motion AI enabled';
      case 'error':
        return 'error';
      default:
        return 'unknown';
    }
  }

  function targetTypesLabel(targetTypes: string[]) {
    return targetTypes.length > 0 ? targetTypes.join(', ') : 'none reported';
  }

  function processHealthLabel(health: string) {
    switch (health) {
      case 'ok':
        return 'green';
      case 'stale':
        return 'stale';
      case 'error':
        return 'error';
      default:
        return 'missing';
    }
  }

  function processLastAliveLabel(tsMs: number | null) {
    return tsMs ? `${timeAgo(tsMs, nowMs)} ago` : 'never';
  }

  function formatDateTime(tsMs: number) {
    return new Date(tsMs).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    for (const unit of units) {
      if (value < 1024 || unit === units.at(-1)) {
        return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
      }
      value /= 1024;
    }

    return `${bytes} B`;
  }

  function selectReviewEvent(event: ReviewableSecurityEvent) {
    selectedReviewEventId = event.id;
  }

  function recordingSource(event: ReviewableSecurityEvent) {
    const segment = event.preferredSegment;
    if (!segment) {
      return null;
    }

    const params = new URLSearchParams({ path: segment.relativePath });
    const offsetSeconds = Math.max(0, Math.floor((event.occurredAtMs - segment.startMs) / 1000));
    return `/api/recordings/file?${params.toString()}#t=${offsetSeconds}`;
  }

  function recordingQualityLabel(event: ReviewableSecurityEvent) {
    if (!event.preferredSegment) {
      return 'no recording';
    }

    return event.preferredSegment.role === 'main' ? 'full quality' : 'substream';
  }

  async function saveCredentials(camera: DiscoveredCamera, event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formData = new FormData(form);
    const username = String(formData.get('username') ?? '');
    const password = String(formData.get('password') ?? '');

    credentialStatus = {
      ...credentialStatus,
      [camera.id]: { state: 'saving', message: 'Saving credentials...' }
    };

    try {
      const response = await fetch('/api/cameras/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cameraId: camera.id,
          host: camera.remoteAddress,
          username,
          password
        })
      });

      if (!response.ok) {
        throw new Error(`Credential save failed with HTTP ${response.status}`);
      }
      setCameraSnapshotFromPayload(await response.json());

      credentialStatus = {
        ...credentialStatus,
        [camera.id]: { state: 'saved', message: 'Credentials saved to event logs.' }
      };
      form.reset();
    } catch (caught) {
      credentialStatus = {
        ...credentialStatus,
        [camera.id]: {
          state: 'error',
          message: caught instanceof Error ? caught.message : String(caught)
        }
      };
    }
  }
</script>

<svelte:head>
  <title>Patrol</title>
</svelte:head>

<main class="shell" aria-label="Patrol home">
  <header class="topbar">
    <div>
      <p class="eyebrow">Patrol</p>
      <h1>
        {activeTab === 'cameras'
          ? 'Cameras'
          : activeTab === 'history'
            ? 'History'
            : activeTab === 'settings'
              ? 'Settings'
              : 'System Health'}
      </h1>
    </div>
    {#if discoveryState?.lastDiscovery}
      <p class="topbar-meta">{discoveryState.devices.length} known</p>
    {/if}
  </header>

  {#if error}
    <p class="notice error" role="alert">{error}</p>
  {/if}

  {#if activeTab === 'cameras'}
    <section class="view" aria-labelledby="cameras-title">
      <h2 id="cameras-title" class="sr-only">Camera streams</h2>

      {#if configuredCameras.length > 0}
        <ul class="camera-grid" aria-label="Configured camera streams">
          {#each configuredCameras as camera}
            <li class="camera-tile">
              <iframe
                src={go2rtcStreamPath(camera, 'sub')}
                title={`${displayName(camera)} go2rtc preview`}
                data-testid="camera-preview-frame"
              ></iframe>
              <div class="camera-tile-footer">
                <div>
                  <h3>{displayName(camera)}</h3>
                  <p>{camera.remoteAddress}</p>
                </div>
                <a
                  href={cameraPath(camera)}
                  aria-label={`Open high-resolution live view for ${displayName(camera)}`}
                  data-testid="camera-preview-link"
                >
                  Open
                </a>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <section class="empty-state" aria-label="No configured cameras">
          <h2>No configured cameras</h2>
          <p>Use Settings to discover cameras and save credentials before live views appear here.</p>
          <button type="button" disabled={!hydrated} onclick={() => (activeTab = 'settings')}>Open Settings</button>
        </section>
      {/if}
    </section>
  {:else if activeTab === 'history'}
    <section class="view" aria-labelledby="history-title">
      <div class="section-header">
        <div>
          <h2 id="history-title">Recorded Events</h2>
          <p>Review camera-side vehicle, person, and motion events against retained recordings.</p>
          <p class="event-path">Recordings keep main stream quality for 7 days and substream quality for 30 days.</p>
        </div>
      </div>

      {#if discoveryState?.recordings}
        <div class="storage-summary" data-testid="recording-storage">
          <div>
            <span>Estimated total</span>
            <strong>{formatBytes(discoveryState.recordings.storage.totalEstimatedBytes)}</strong>
          </div>
          <div>
            <span>Full quality</span>
            <strong>{formatBytes(discoveryState.recordings.storage.mainEstimatedBytes)}</strong>
          </div>
          <div>
            <span>Substream</span>
            <strong>{formatBytes(discoveryState.recordings.storage.subEstimatedBytes)}</strong>
          </div>
          <div>
            <span>Observed on disk</span>
            <strong>{formatBytes(discoveryState.recordings.storage.observedBytes)}</strong>
          </div>
        </div>

        {#if selectedReviewEvent}
          {@const selectedEvent = selectedReviewEvent}
            <section class="recording-player" aria-label="Selected event recording" data-testid="recording-player">
              <div class="recording-player-header">
                <div>
                  <h3>{selectedEvent.label}</h3>
                  <p>
                    {cameraById(selectedEvent.cameraId)?.name ?? cameraById(selectedEvent.cameraId)?.remoteAddress ?? 'Unknown camera'}
                    · {formatDateTime(selectedEvent.occurredAtMs)}
                    · {selectedRecordingQuality}
                  </p>
                </div>
              </div>
              {#if selectedRecordingSource}
                {#key selectedRecordingSource}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video
                    src={selectedRecordingSource}
                    controls
                    playsinline
                    preload="metadata"
                    data-testid="recording-video"
                  ></video>
                {/key}
              {:else}
                <p class="notice compact">
                  No retained recording segment currently overlaps this event.
                </p>
              {/if}
            </section>
        {/if}

        {#if discoveryState.recordings.events.length > 0}
          <ol class="history-list" aria-label="Observed security events">
            {#each discoveryState.recordings.events as event}
              <li data-testid="history-event-row">
                <button
                  type="button"
                  class="history-event"
                  class:active={event.id === selectedReviewEventId}
                  disabled={!event.preferredSegment}
                  onclick={() => selectReviewEvent(event)}
                >
                  <span>
                    <strong>{event.label}</strong>
                    <small>
                      {cameraById(event.cameraId)?.name ?? cameraById(event.cameraId)?.remoteAddress ?? 'Unknown camera'}
                      · {formatDateTime(event.occurredAtMs)}
                    </small>
                  </span>
                  <span>{recordingQualityLabel(event)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="notice">No vehicle, person, or motion events have been observed yet.</p>
        {/if}
      {:else}
        <p class="notice">Recording state has not been replayed yet.</p>
      {/if}
    </section>
  {:else if activeTab === 'settings'}
    <section class="view" aria-labelledby="settings-title">
      <div class="section-header">
        <div>
          <h2 id="settings-title">Discovery & Configuration</h2>
          <p>Find ONVIF cameras, open first-time setup, and save credentials for Patrol.</p>
          <p class="event-path">Events append to <code>.patrol/events/cameras-YYYY-MM-DD.jsonl</code>.</p>
        </div>
        <button
          type="button"
          onclick={discoverCameras}
          disabled={discovering || !hydrated}
          aria-busy={discovering}
          data-testid="discover-cameras"
        >
          {discovering ? 'Scanning...' : 'Discover'}
        </button>
      </div>

      {#if discoveryState?.lastDiscovery}
        <div class="status" aria-live="polite">
          <span>
            {discoveryState.devices.length} camera{discoveryState.devices.length === 1 ? '' : 's'} found
          </span>
          <span>{discoveryState.lastDiscovery.durationMs} ms</span>
          <span>Last discovery {timeAgo(discoveryState.lastDiscovery.completedAtMs, nowMs)} ago</span>
          <span>Showing cameras seen in the last {formatWindow(discoveryState.staleAfterMs)}</span>
          <span>Event replayed</span>
        </div>

        {#if discoveryState.errors.length > 0}
          <ul class="notice error-list" aria-label="Discovery errors">
            {#each discoveryState.errors as discoveryError}
              <li>{discoveryError}</li>
            {/each}
          </ul>
        {/if}

        {#if discoveryState.devices.length > 0}
          <ul class="settings-list" aria-label="Discovered cameras">
            {#each discoveryState.devices as camera}
              <li class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>{displayName(camera)}</h3>
                    <p>{camera.remoteAddress}</p>
                    <p class="freshness">Discovered {timeAgo(camera.lastSeenAtMs, nowMs)} ago</p>
                  </div>
                  <a href={camera.setupUrl} target="_blank" rel="noreferrer">Open camera setup</a>
                </div>

                <dl>
                  <div>
                    <dt>Vendor</dt>
                    <dd>{camera.vendorHint ?? 'Unknown from ONVIF discovery'}</dd>
                  </div>
                  <div>
                    <dt>Hardware</dt>
                    <dd>{camera.hardware ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Endpoint</dt>
                    <dd>{camera.endpoint ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>XAddrs</dt>
                    <dd>{camera.xaddrs.join(', ') || 'None reported'}</dd>
                  </div>
                </dl>

                <form class="credentials-form" onsubmit={(event) => saveCredentials(camera, event)}>
                  <label>
                    <span>Username for {displayName(camera)}</span>
                    <input name="username" autocomplete="username" required />
                  </label>
                  <label>
                    <span>Password for {displayName(camera)}</span>
                    <input name="password" type="password" autocomplete="current-password" required />
                  </label>
                  <button
                    type="submit"
                    class="secondary"
                    disabled={credentialStatus[camera.id]?.state === 'saving'}
                  >
                    {credentialStatus[camera.id]?.state === 'saving' ? 'Saving...' : 'Save credentials'}
                  </button>
                </form>

                {#if camera.credentials}
                  <p class="credential-status success" role="status">
                    Credentials saved {timeAgo(camera.credentials.savedAtMs, nowMs)} ago.
                  </p>
                {/if}

                {#if credentialStatus[camera.id]}
                  <p
                    class:error={credentialStatus[camera.id].state === 'error'}
                    class:success={credentialStatus[camera.id].state === 'saved'}
                    class="credential-status"
                    role="status"
                  >
                    {credentialStatus[camera.id].message}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="notice">No cameras responded to the ONVIF discovery probe.</p>
        {/if}
      {:else}
        <p class="notice">Run discovery to find cameras on the local network.</p>
      {/if}
    </section>
  {:else}
    <section class="view" aria-labelledby="health-title">
      <section
        class="process-dashboard"
        data-health={allProcessesGreen ? 'ok' : 'attention'}
        aria-labelledby="process-dashboard-title"
        data-testid="process-dashboard"
      >
        <div class="process-dashboard-header">
          <div>
            <h2 id="process-dashboard-title">Server Tasks</h2>
            <p>{allProcessesGreen ? 'All server tasks are green.' : 'One or more server tasks need attention.'}</p>
          </div>
          <span class="process-score" data-testid="process-score">
            {processGreenCount}/{discoveryState?.processes.length ?? 0} green
          </span>
        </div>
        {#if discoveryState?.processes.length}
          <ul class="process-list" aria-label="Server task health">
            {#each discoveryState.processes as process}
              <li data-health={process.health} data-testid="process-row">
                <div>
                  <strong>{process.label}</strong>
                  <p>{process.detail}</p>
                </div>
                <div class="process-meta">
                  <span class="process-pill" data-health={process.health}>{processHealthLabel(process.health)}</span>
                  <span>last alive {processLastAliveLabel(process.lastAliveAtMs)}</span>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="notice compact">No server task state has been replayed yet.</p>
        {/if}
      </section>

      <div class="section-header">
        <div>
          <h2 id="health-title">Monitoring</h2>
          <p>Observe go2rtc and Annke camera-side AI facts into system health.</p>
        </div>
        <div class="section-actions">
          <button
            type="button"
            onclick={observeGo2rtc}
            disabled={observingGo2rtc || !hydrated}
            aria-busy={observingGo2rtc}
            data-testid="observe-go2rtc"
          >
            {observingGo2rtc ? 'Observing...' : 'Observe go2rtc'}
          </button>
          <button
            type="button"
            class="secondary"
            onclick={observeAnnkeAi}
            disabled={observingAnnkeAi || !hydrated}
            aria-busy={observingAnnkeAi}
            data-testid="observe-annke-ai"
          >
            {observingAnnkeAi ? 'Observing...' : 'Observe Annke AI'}
          </button>
        </div>
      </div>

      {#if discoveryState?.devices.length}
        <ul class="health-list" aria-label="Camera health">
          {#each discoveryState.devices as camera}
            <li class="health-card">
              <div class="health-card-header">
                <div>
                  <h3>{displayName(camera)}</h3>
                  <p>{camera.remoteAddress}</p>
                </div>
                {#if camera.go2rtc}
                  <span class="health-pill" data-health={camera.go2rtc.health}>
                    {healthLabel(camera.go2rtc.health)}
                  </span>
                {:else}
                  <span class="health-pill" data-health="offline">unconfigured</span>
                {/if}
              </div>

              {#if camera.go2rtc}
                <div class="go2rtc-status" data-health={camera.go2rtc.health} data-testid="go2rtc-camera-status">
                  <p>
                    go2rtc {healthLabel(camera.go2rtc.health)}
                    {#if camera.go2rtc.observedAtMs}
                      · observed {timeAgo(camera.go2rtc.observedAtMs, nowMs)} ago
                    {/if}
                  </p>
                  <ul>
                    <li>
                      Main {healthLabel(camera.go2rtc.streams.main.health)}:
                      {camera.go2rtc.streams.main.producerCount} producer{camera.go2rtc.streams.main.producerCount === 1 ? '' : 's'},
                      {camera.go2rtc.streams.main.consumerCount} consumer{camera.go2rtc.streams.main.consumerCount === 1 ? '' : 's'}
                    </li>
                    <li>
                      Sub {healthLabel(camera.go2rtc.streams.sub.health)}:
                      {camera.go2rtc.streams.sub.producerCount} producer{camera.go2rtc.streams.sub.producerCount === 1 ? '' : 's'},
                      {camera.go2rtc.streams.sub.consumerCount} consumer{camera.go2rtc.streams.sub.consumerCount === 1 ? '' : 's'}
                    </li>
                  </ul>
                </div>
              {:else}
                <p class="notice compact" data-testid="go2rtc-camera-status">
                  go2rtc has not materialized stream configuration for this camera yet.
                </p>
              {/if}

              {#if camera.annke}
                <div class="annke-status" data-health={camera.annke.health} data-testid="annke-ai-status">
                  <p>
                    Annke AI {annkeHealthLabel(camera.annke.health)}
                    {#if camera.annke.observedAtMs}
                      · observed {timeAgo(camera.annke.observedAtMs, nowMs)} ago
                    {/if}
                  </p>
                  <ul>
                    <li>
                      Motion detection:
                      {camera.annke.motionDetection.enabled === true ? 'enabled' : camera.annke.motionDetection.enabled === false ? 'disabled' : 'unknown'}
                    </li>
                    <li>Targets: {targetTypesLabel(camera.annke.motionDetection.targetTypes)}</li>
                    {#if camera.annke.lastAlert}
                      <li>
                        Last alert:
                        {camera.annke.lastAlert.targetType ?? camera.annke.lastAlert.eventType ?? 'unknown'}
                        {camera.annke.lastAlert.eventState ?? 'unknown'}
                        {timeAgo(camera.annke.lastAlert.receivedAtMs, nowMs)} ago
                      </li>
                    {/if}
                  </ul>
                </div>
              {:else}
                <p class="notice compact" data-testid="annke-ai-status">
                  Annke camera-side AI has not been observed yet.
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="notice">No camera state has been replayed yet.</p>
      {/if}

      <section class="live-event-panel" aria-labelledby="live-events-title" data-testid="live-event-panel">
        <div class="live-event-header">
          <div>
            <h2 id="live-events-title">Live Events</h2>
            <p>Newest append-only event log messages received over WebSocket.</p>
          </div>
          <span
            class="live-event-status"
            data-state={liveEventStatus}
            data-testid="live-event-status"
          >
            {liveEventStatus}
          </span>
        </div>
        <p class="event-path"><code>{liveEventUrl || `ws://localhost:${liveEventPort}/ws/events`}</code></p>
        {#if liveEventError}
          <p class="notice error compact" role="alert">{liveEventError}</p>
        {/if}
        {#if liveEvents.length > 0}
          <ol class="live-event-list" aria-label="Received live events">
            {#each liveEvents as event}
              <li data-testid="live-event-row">
                <div class="live-event-row-header">
                  <strong>{event.eventType ?? event.messageType}</strong>
                  <span>{timeAgo(event.receivedAtMs, nowMs)} ago</span>
                </div>
                <p>
                  {#if event.stream}{event.stream} · {/if}
                  {#if event.source}{event.source} · {/if}
                  {event.summary}
                </p>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="notice compact">Waiting for new events from the event log.</p>
        {/if}
      </section>
    </section>
  {/if}
</main>

<nav class="tabbar" aria-label="Primary">
  <button
    type="button"
    class:active={activeTab === 'cameras'}
    aria-label="Cameras"
    aria-current={activeTab === 'cameras' ? 'page' : undefined}
    data-testid="tab-cameras"
    disabled={!hydrated}
    onclick={() => (activeTab = 'cameras')}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h12v10H4z"></path>
      <path d="m16 10 4-2v8l-4-2z"></path>
    </svg>
    <span>Cameras</span>
  </button>
  <button
    type="button"
    class:active={activeTab === 'settings'}
    aria-label="Settings"
    aria-current={activeTab === 'settings' ? 'page' : undefined}
    data-testid="tab-settings"
    disabled={!hydrated}
    onclick={() => (activeTab = 'settings')}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"></path>
    </svg>
    <span>Settings</span>
  </button>
  <button
    type="button"
    class:active={activeTab === 'history'}
    aria-label="History"
    aria-current={activeTab === 'history' ? 'page' : undefined}
    data-testid="tab-history"
    disabled={!hydrated}
    onclick={() => (activeTab = 'history')}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7"></path>
      <path d="M3 4v5h5"></path>
      <path d="M12 7v5l3 2"></path>
    </svg>
    <span>History</span>
  </button>
  <button
    type="button"
    class:active={activeTab === 'health'}
    aria-label="System health"
    aria-current={activeTab === 'health' ? 'page' : undefined}
    data-testid="tab-health"
    disabled={!hydrated}
    onclick={() => (activeTab = 'health')}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 13h4l2-6 4 10 2-4h4"></path>
      <path d="M4 19h16"></path>
    </svg>
    <span>Health</span>
  </button>
</nav>

<style>
  :global(body) {
    margin: 0;
    background: #f4f5f2;
    color: #171a1f;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
  }

  .shell {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 18px 16px 104px;
  }

  .topbar,
  .view {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 1120px;
  }

  .topbar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }

  .eyebrow {
    margin: 0 0 4px;
    color: #66727f;
    font-size: 0.78rem;
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0;
    font-size: 1.65rem;
    font-weight: 700;
    letter-spacing: 0;
  }

  h2 {
    margin-bottom: 4px;
    font-size: 1rem;
  }

  h3 {
    margin-bottom: 4px;
    font-size: 0.95rem;
  }

  .topbar-meta {
    margin-bottom: 2px;
    color: #66727f;
    font-size: 0.88rem;
  }

  .section-header {
    display: grid;
    gap: 14px;
    margin-bottom: 16px;
    border: 1px solid #d9dde2;
    border-radius: 8px;
    background: #ffffff;
    padding: 16px;
  }

  .section-actions {
    display: grid;
    gap: 8px;
  }

  .section-header p {
    margin-bottom: 0;
    color: #66727f;
    line-height: 1.4;
  }

  .process-dashboard {
    margin-bottom: 16px;
    border: 1px solid #d9dde2;
    border-radius: 8px;
    background: #ffffff;
    padding: 16px;
  }

  .process-dashboard[data-health="ok"] {
    border-color: #9bc4ad;
    background: #f7fcf9;
  }

  .process-dashboard[data-health="attention"] {
    border-color: #dfc979;
    background: #fffdf5;
  }

  .process-dashboard-header,
  .process-list li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
  }

  .process-dashboard-header {
    margin-bottom: 12px;
  }

  .process-dashboard-header p,
  .process-list p {
    margin-bottom: 0;
    color: #66727f;
    line-height: 1.4;
  }

  .process-score,
  .process-pill {
    border: 1px solid #d5d8dc;
    border-radius: 999px;
    padding: 4px 10px;
    color: #3d4752;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .process-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .process-list li {
    border: 1px solid #d5d8dc;
    border-radius: 6px;
    background: #ffffff;
    padding: 10px 12px;
  }

  .process-list li > div:first-child {
    min-width: 0;
  }

  .process-list li[data-health="ok"],
  .process-pill[data-health="ok"] {
    border-color: #9bc4ad;
    background: #f2fbf5;
    color: #17683a;
  }

  .process-list li[data-health="stale"],
  .process-pill[data-health="stale"],
  .process-list li[data-health="missing"],
  .process-pill[data-health="missing"] {
    border-color: #dfc979;
    background: #fff9e8;
    color: #725d0d;
  }

  .process-list li[data-health="error"],
  .process-pill[data-health="error"] {
    border-color: #dfa6a6;
    background: #fff5f5;
    color: #9f1d1d;
  }

  .process-meta {
    display: grid;
    justify-items: end;
    gap: 4px;
    color: #66727f;
    font-size: 0.84rem;
    text-align: right;
  }

  .event-path {
    margin-top: 6px;
    font-size: 0.85rem;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  button,
  .camera-tile-footer a,
  .settings-card-header a {
    border: 1px solid #1f2937;
    border-radius: 6px;
    background: #1f2937;
    color: #ffffff;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 9px 14px;
    text-align: center;
    text-decoration: none;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .secondary {
    width: fit-content;
    min-width: 144px;
    border-color: #cbd1d8;
    background: #ffffff;
    color: #1f2937;
  }

  .camera-grid,
  .settings-list,
  .health-list,
  .history-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .camera-tile,
  .settings-card,
  .health-card,
  .empty-state,
  .recording-player {
    border: 1px solid #d9dde2;
    border-radius: 8px;
    background: #ffffff;
  }

  .camera-tile {
    overflow: hidden;
  }

  .camera-tile iframe {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    background: #111827;
  }

  .camera-tile-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
  }

  .camera-tile-footer p,
  .settings-card p,
  .health-card p {
    margin-bottom: 0;
    color: #66727f;
  }

  .camera-tile-footer a {
    min-width: 72px;
  }

  .storage-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }

  .storage-summary div {
    display: grid;
    gap: 4px;
    border: 1px solid #d9dde2;
    border-radius: 8px;
    background: #ffffff;
    padding: 12px;
  }

  .storage-summary span,
  .history-event small,
  .recording-player p {
    color: #66727f;
  }

  .storage-summary span {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .storage-summary strong {
    font-size: 1rem;
  }

  .recording-player {
    display: grid;
    gap: 12px;
    margin-bottom: 12px;
    padding: 14px;
  }

  .recording-player-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .recording-player h3,
  .recording-player p {
    margin-bottom: 0;
  }

  .recording-player video {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    background: #111827;
  }

  .history-list li {
    margin: 0;
  }

  .history-event {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    border-color: #d9dde2;
    background: #ffffff;
    color: #171a1f;
    padding: 12px;
    text-align: left;
  }

  .history-event:disabled {
    cursor: default;
  }

  .history-event.active {
    border-color: #1f4f82;
    background: #f2f7fc;
  }

  .history-event > span:first-child {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .history-event > span:last-child {
    color: #3d4752;
    font-size: 0.82rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .empty-state {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .empty-state p {
    margin-bottom: 0;
    color: #66727f;
    line-height: 1.45;
  }

  .empty-state button {
    width: fit-content;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 16px;
  }

  .status span {
    border: 1px solid #d5d8dc;
    border-radius: 999px;
    background: #ffffff;
    padding: 4px 10px;
    color: #3d4752;
    font-size: 0.85rem;
  }

  .settings-card,
  .health-card {
    padding: 16px;
  }

  .settings-card-header,
  .health-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .settings-card-header a {
    border-color: #cbd1d8;
    background: #ffffff;
    color: #1f2937;
  }

  dl {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  dl div {
    display: grid;
    gap: 2px;
  }

  dt {
    color: #66727f;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .credentials-form {
    display: grid;
    gap: 12px;
    margin-top: 16px;
    border-top: 1px solid #e2e5e9;
    padding-top: 16px;
  }

  label {
    display: grid;
    gap: 6px;
  }

  label span {
    color: #3d4752;
    font-size: 0.85rem;
    font-weight: 650;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid #cbd1d8;
    border-radius: 6px;
    background: #ffffff;
    color: #171a1f;
    font: inherit;
    padding: 9px 10px;
  }

  .credential-status {
    margin: 12px 0 0;
  }

  .success {
    color: #17683a;
  }

  .notice {
    margin: 0 0 16px;
    color: #52606d;
  }

  .compact {
    margin-bottom: 0;
  }

  .error {
    color: #9f1d1d;
  }

  .error-list {
    padding-left: 20px;
  }

  .health-pill {
    border: 1px solid #d5d8dc;
    border-radius: 999px;
    padding: 4px 10px;
    color: #3d4752;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .health-pill[data-health="streaming"],
  .health-pill[data-health="ready"] {
    border-color: #9bc4ad;
    background: #f2fbf5;
    color: #17683a;
  }

  .health-pill[data-health="partial"] {
    border-color: #dfc979;
    background: #fff9e8;
    color: #725d0d;
  }

  .health-pill[data-health="offline"] {
    border-color: #dfa6a6;
    background: #fff5f5;
    color: #9f1d1d;
  }

  .go2rtc-status {
    border: 1px solid #d5d8dc;
    border-radius: 6px;
    background: #f9fafb;
    padding: 10px 12px;
  }

  .annke-status {
    margin-top: 10px;
    border: 1px solid #d5d8dc;
    border-radius: 6px;
    background: #f9fafb;
    padding: 10px 12px;
  }

  .annke-status[data-health="motion_enabled"],
  .annke-status[data-health="alert_idle"] {
    border-color: #9bc4ad;
    background: #f2fbf5;
  }

  .annke-status[data-health="alert_active"] {
    border-color: #dfc979;
    background: #fff9e8;
  }

  .annke-status[data-health="error"] {
    border-color: #dfa6a6;
    background: #fff5f5;
  }

  .annke-status p {
    margin-bottom: 6px;
    color: #3d4752;
    font-weight: 650;
  }

  .annke-status ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 18px;
    color: #52606d;
    font-size: 0.88rem;
  }

  .live-event-panel {
    margin-top: 12px;
    border: 1px solid #d9dde2;
    border-radius: 8px;
    background: #ffffff;
    padding: 16px;
  }

  .live-event-header,
  .live-event-row-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .live-event-header p {
    margin-bottom: 0;
    color: #66727f;
    line-height: 1.4;
  }

  .live-event-status {
    border: 1px solid #d5d8dc;
    border-radius: 999px;
    padding: 4px 10px;
    color: #3d4752;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .live-event-status[data-state="connected"] {
    border-color: #9bc4ad;
    background: #f2fbf5;
    color: #17683a;
  }

  .live-event-status[data-state="error"],
  .live-event-status[data-state="disconnected"] {
    border-color: #dfa6a6;
    background: #fff5f5;
    color: #9f1d1d;
  }

  .live-event-list {
    display: grid;
    gap: 8px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }

  .live-event-list li {
    border: 1px solid #d5d8dc;
    border-radius: 6px;
    background: #f9fafb;
    padding: 10px 12px;
  }

  .live-event-row-header strong {
    overflow-wrap: anywhere;
  }

  .live-event-row-header span,
  .live-event-list p {
    color: #66727f;
    font-size: 0.85rem;
  }

  .live-event-list p {
    margin-bottom: 0;
    overflow-wrap: anywhere;
  }

  .go2rtc-status[data-health="streaming"],
  .go2rtc-status[data-health="ready"] {
    border-color: #9bc4ad;
    background: #f2fbf5;
  }

  .go2rtc-status[data-health="partial"] {
    border-color: #dfc979;
    background: #fff9e8;
  }

  .go2rtc-status[data-health="offline"] {
    border-color: #dfa6a6;
    background: #fff5f5;
  }

  .go2rtc-status p {
    margin-bottom: 6px;
    color: #3d4752;
    font-weight: 650;
  }

  .go2rtc-status ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 18px;
    color: #52606d;
    font-size: 0.88rem;
  }

  .tabbar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    border-top: 1px solid #d5d8dc;
    background: rgb(255 255 255 / 0.96);
    padding: 8px max(8px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    box-shadow: 0 -8px 24px rgb(23 26 31 / 0.08);
  }

  .tabbar button {
    display: grid;
    justify-items: center;
    gap: 3px;
    min-width: 0;
    border-color: transparent;
    background: transparent;
    color: #66727f;
    padding: 6px 4px;
  }

  .tabbar button.active {
    color: #171a1f;
  }

  .tabbar svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .tabbar span {
    font-size: 0.72rem;
    font-weight: 700;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  @media (min-width: 760px) {
    .shell {
      padding: 28px 28px 112px;
    }

    .camera-grid {
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    }

    .section-header {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
    }

    .tabbar {
      right: 50%;
      left: 50%;
      width: min(440px, calc(100% - 32px));
      transform: translateX(-50%);
      border: 1px solid #d5d8dc;
      border-radius: 16px 16px 0 0;
    }
  }
</style>
