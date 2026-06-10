<script lang="ts">
  import { onMount } from 'svelte';
  import type { CameraDiscoveryState, DiscoveredCamera } from '$lib/cameras/discovery';

  let discoveryState: CameraDiscoveryState | null = null;
  let error: string | null = null;
  let discovering = false;
  let hydrated = false;
  let nowMs = Date.now();
  let credentialStatus: Record<string, { state: 'saving' | 'saved' | 'error'; message: string }> = {};

  onMount(() => {
    hydrated = true;
    void loadDiscoveryState();
    const interval = window.setInterval(() => {
      nowMs = Date.now();
    }, 60000);

    return () => window.clearInterval(interval);
  });

  async function loadDiscoveryState() {
    try {
      const response = await fetch('/api/cameras/discover');
      if (!response.ok) {
        throw new Error(`Discovery state failed with HTTP ${response.status}`);
      }
      discoveryState = (await response.json()) as CameraDiscoveryState;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
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
      discoveryState = (await response.json()) as CameraDiscoveryState;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      discovering = false;
    }
  }

  function displayName(camera: DiscoveredCamera) {
    return camera.name ?? camera.hardware ?? camera.remoteAddress;
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
      discoveryState = (await response.json()) as CameraDiscoveryState;

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
  <section class="hero" aria-labelledby="page-title">
    <p class="eyebrow">Camera Setup</p>
    <h1 id="page-title">Patrol</h1>
    <p class="summary">
      Discover ONVIF cameras on the local network and prepare them for Patrol configuration.
    </p>
  </section>

  <section class="panel" aria-labelledby="discovery-title">
    <div class="panel-header">
      <div>
        <h2 id="discovery-title">Camera Discovery</h2>
        <p>Uses ONVIF WS-Discovery from the Patrol server process.</p>
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

    {#if error}
      <p class="notice error" role="alert">{error}</p>
    {:else if discoveryState?.lastDiscovery}
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
        <ul class="camera-list" aria-label="Discovered cameras">
          {#each discoveryState.devices as camera}
            <li class="camera-card">
              <div>
                <h3>{displayName(camera)}</h3>
                <p>{camera.remoteAddress}</p>
                <p class="freshness">Discovered {timeAgo(camera.lastSeenAtMs, nowMs)} ago</p>
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

              <div class="setup-actions">
                <a href={camera.setupUrl} target="_blank" rel="noreferrer">
                  Open camera setup
                </a>
                <p>
                  Use this link for first-time camera setup, then enter the camera credentials
                  Patrol should use.
                </p>
              </div>

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
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f7f7f4;
    color: #171a1f;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
  }

  .shell {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 32px;
  }

  .hero {
    margin: 0 auto 24px;
    max-width: 920px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #52606d;
    font-size: 0.8rem;
    font-weight: 700;
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
    margin-bottom: 8px;
    font-size: 2rem;
    font-weight: 650;
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

  .summary {
    max-width: 620px;
    color: #52606d;
    line-height: 1.5;
  }

  .panel {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 920px;
    border: 1px solid #d5d8dc;
    border-radius: 8px;
    background: #ffffff;
    padding: 20px;
  }

  .panel-header {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .panel-header p {
    margin-bottom: 0;
    color: #66727f;
    line-height: 1.4;
  }

  .panel-header .event-path {
    margin-top: 6px;
    font-size: 0.85rem;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  button {
    min-width: 104px;
    border: 1px solid #1f2937;
    border-radius: 6px;
    background: #1f2937;
    color: #ffffff;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    padding: 9px 14px;
  }

  a {
    color: #1f4f82;
    font-weight: 650;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }

  .status span {
    border: 1px solid #d5d8dc;
    border-radius: 999px;
    padding: 4px 10px;
    color: #3d4752;
    font-size: 0.85rem;
  }

  .notice {
    margin: 18px 0 0;
    color: #52606d;
  }

  .error {
    color: #9f1d1d;
  }

  .error-list {
    padding-left: 20px;
  }

  .camera-list {
    display: grid;
    gap: 12px;
    margin: 18px 0 0;
    padding: 0;
    list-style: none;
  }

  .camera-card {
    border: 1px solid #e2e5e9;
    border-radius: 8px;
    padding: 16px;
  }

  .camera-card p {
    margin-bottom: 12px;
    color: #66727f;
  }

  .setup-actions {
    display: grid;
    gap: 6px;
    margin-top: 16px;
    border-top: 1px solid #e2e5e9;
    padding-top: 16px;
  }

  .setup-actions p {
    margin-bottom: 0;
  }

  .credentials-form {
    display: grid;
    gap: 12px;
    margin-top: 16px;
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

  .secondary {
    width: fit-content;
    min-width: 144px;
    border-color: #cbd1d8;
    background: #ffffff;
    color: #1f2937;
  }

  .credential-status {
    margin: 12px 0 0;
  }

  .success {
    color: #17683a;
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

  @media (max-width: 640px) {
    .shell {
      padding: 20px;
    }

    .panel-header {
      display: grid;
    }

    button {
      width: 100%;
    }
  }
</style>
