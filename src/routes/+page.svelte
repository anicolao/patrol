<script lang="ts">
  import { onMount } from 'svelte';
  import type { CameraDiscoveryResult, DiscoveredCamera } from '$lib/cameras/discovery';

  let result: CameraDiscoveryResult | null = null;
  let error: string | null = null;
  let discovering = false;
  let hydrated = false;

  onMount(() => {
    hydrated = true;
  });

  async function discoverCameras() {
    discovering = true;
    error = null;

    try {
      const response = await fetch('/api/cameras/discover', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Discovery failed with HTTP ${response.status}`);
      }
      result = (await response.json()) as CameraDiscoveryResult;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      discovering = false;
    }
  }

  function displayName(camera: DiscoveredCamera) {
    return camera.name ?? camera.hardware ?? camera.remoteAddress;
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
    {:else if result}
      <div class="status" aria-live="polite">
        <span>{result.devices.length} camera{result.devices.length === 1 ? '' : 's'} found</span>
        <span>{result.durationMs} ms</span>
      </div>

      {#if result.errors.length > 0}
        <ul class="notice error-list" aria-label="Discovery errors">
          {#each result.errors as discoveryError}
            <li>{discoveryError}</li>
          {/each}
        </ul>
      {/if}

      {#if result.devices.length > 0}
        <ul class="camera-list" aria-label="Discovered cameras">
          {#each result.devices as camera}
            <li class="camera-card">
              <div>
                <h3>{displayName(camera)}</h3>
                <p>{camera.remoteAddress}</p>
              </div>

              <dl>
                <div>
                  <dt>Vendor</dt>
                  <dd>{camera.vendorHint ?? 'Unknown'}</dd>
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
