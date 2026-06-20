<script lang="ts">
  import type { PageData } from './$types';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let { data }: { data: PageData } = $props();

  const hasCameraControls = $derived(
    data.camera.controls.ptz.supported || data.camera.controls.supplementLight.supported
  );
  let controlMessage = $state('');
  let lightMode = $state('unknown');
  let lightBusy = $state(false);
  let activePtzCommand = $state<string | null>(null);

  onMount(() => {
    if (data.camera.controls.supplementLight.supported) {
      void refreshLight();
    }
  });

  function displayName() {
    return data.camera.name ?? data.camera.hardware ?? data.camera.remoteAddress;
  }

  function liveStreamPath() {
    const baseUrl = browser ? `${window.location.protocol}//${window.location.hostname}:1984` : 'http://127.0.0.1:1984';
    const params = new URLSearchParams({
      src: data.camera.streams.main,
      mode: 'webrtc,mse,hls',
      width: '100%',
      background: 'false'
    });
    return `${baseUrl}/stream.html?${params.toString()}`;
  }

  async function sendPtz(command: string, pan: number, tilt: number, zoom = 0) {
    activePtzCommand = command;
    controlMessage = '';
    try {
      await postControl('ptz', { pan, tilt, zoom });
      controlMessage = `${command} sent`;
    } catch (caught) {
      controlMessage = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function stopPtz() {
    activePtzCommand = null;
    try {
      await postControl('ptz', { action: 'stop' });
    } catch (caught) {
      controlMessage = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function setLight(mode: string) {
    lightBusy = true;
    controlMessage = '';
    try {
      const result = await postControl('light', { mode });
      if (typeof result.mode === 'string') {
        lightMode = result.mode;
      }
      controlMessage = `Light ${lightMode}`;
    } catch (caught) {
      controlMessage = caught instanceof Error ? caught.message : String(caught);
    } finally {
      lightBusy = false;
    }
  }

  async function refreshLight() {
    try {
      const response = await fetch(`/api/cameras/${encodeURIComponent(data.camera.id)}/light`);
      const result = await response.json();
      if (response.ok && typeof result.mode === 'string') {
        lightMode = result.mode;
      }
    } catch {
      controlMessage = 'Light status unavailable';
    }
  }

  async function postControl(endpoint: 'ptz' | 'light', body: Record<string, unknown>) {
    const response = await fetch(`/api/cameras/${encodeURIComponent(data.camera.id)}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof result.error === 'string' ? result.error : `${endpoint} command failed`);
    }
    return result;
  }
</script>

<svelte:head>
  <title>{displayName()} - Patrol</title>
</svelte:head>

<main class="shell" aria-label="Camera live view">
  <header class="camera-header">
    <div>
      <a href="/" class="back-link">Back to cameras</a>
      <p class="eyebrow">Live Camera</p>
      <h1>{displayName()}</h1>
      <p>{data.camera.remoteAddress}</p>
    </div>
  </header>

  <section class="live-panel" aria-label={`${displayName()} live stream`}>
    <iframe
      class="live-stream"
      src={liveStreamPath()}
      title={`${displayName()} go2rtc live stream`}
      data-testid="live-camera-stream"
    ></iframe>
  </section>

  {#if hasCameraControls}
    <section class="controls-panel" aria-label="Camera controls" data-testid="camera-controls">
      {#if data.camera.controls.ptz.supported}
        <section class="control-group" aria-label="PTZ controls">
          <div>
            <h2>PTZ</h2>
            <p>{activePtzCommand ?? 'idle'}</p>
          </div>
          <div class="ptz-grid">
            <span></span>
            <button type="button" onpointerdown={() => sendPtz('tilt up', 0, 55)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>^</button>
            <span></span>
            <button type="button" onpointerdown={() => sendPtz('pan left', -55, 0)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>&lt;</button>
            <button type="button" onclick={stopPtz}>Stop</button>
            <button type="button" onpointerdown={() => sendPtz('pan right', 55, 0)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>&gt;</button>
            <span></span>
            <button type="button" onpointerdown={() => sendPtz('tilt down', 0, -55)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>v</button>
            <span></span>
          </div>
          <div class="zoom-actions">
            <button type="button" onpointerdown={() => sendPtz('zoom in', 0, 0, 45)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>Zoom +</button>
            <button type="button" onpointerdown={() => sendPtz('zoom out', 0, 0, -45)} onpointerup={stopPtz} onpointercancel={stopPtz} onpointerleave={stopPtz}>Zoom -</button>
          </div>
        </section>
      {/if}

      {#if data.camera.controls.supplementLight.supported}
        <section class="control-group" aria-label="Light controls">
          <div>
            <h2>Light</h2>
            <p>mode {lightMode}</p>
          </div>
          <div class="light-actions">
            <button type="button" disabled={lightBusy} onclick={() => setLight('close')}>Off</button>
            <button type="button" disabled={lightBusy} onclick={() => setLight('eventIntelligence')}>Auto</button>
            <button type="button" disabled={lightBusy} onclick={() => setLight('colorVuWhiteLight')}>White</button>
            <button type="button" disabled={lightBusy} onclick={() => setLight('irLight')}>IR</button>
          </div>
        </section>
      {/if}

      {#if controlMessage}
        <p class="control-status">{controlMessage}</p>
      {/if}
    </section>
  {/if}
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

  .camera-header,
  .live-panel {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 1180px;
  }

  .camera-header {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 18px;
  }

  .back-link {
    display: inline-block;
    margin-bottom: 16px;
    color: #1f4f82;
    font-weight: 650;
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
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 8px;
    font-size: 2rem;
    font-weight: 650;
    letter-spacing: 0;
  }

  .camera-header p:not(.eyebrow) {
    margin-bottom: 0;
    color: #66727f;
  }

  .live-stream {
    display: block;
    width: 100%;
    max-height: calc(100vh - 190px);
    aspect-ratio: 16 / 9;
    border: 1px solid #d5d8dc;
    border-radius: 8px;
    background: #111827;
  }

  .controls-panel {
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
    max-width: 1180px;
    margin: 18px auto 0;
    padding: 16px;
    border: 1px solid #d5d8dc;
    border-radius: 8px;
    background: #ffffff;
  }

  .control-group {
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .control-group h2,
  .control-group p,
  .control-status {
    margin: 0;
  }

  .control-group h2 {
    font-size: 1rem;
    font-weight: 700;
  }

  .control-group p,
  .control-status {
    color: #66727f;
    font-size: 0.9rem;
  }

  .ptz-grid {
    display: grid;
    grid-template-columns: repeat(3, 48px);
    gap: 8px;
    width: max-content;
  }

  .zoom-actions,
  .light-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .ptz-grid button,
  .zoom-actions button,
  .light-actions button {
    min-height: 44px;
    border: 1px solid #b9c1cb;
    border-radius: 8px;
    background: #f8fafc;
    color: #172033;
    font-weight: 700;
  }

  .control-status {
    grid-column: 1 / -1;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  @media (max-width: 640px) {
    .shell {
      padding: 20px;
    }

    .live-stream {
      max-height: none;
    }
  }
</style>
