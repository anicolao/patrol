<script lang="ts">
  import type { PageData } from './$types';
  import { browser } from '$app/environment';

  let { data }: { data: PageData } = $props();

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

  @media (max-width: 640px) {
    .shell {
      padding: 20px;
    }

    .live-stream {
      max-height: none;
    }
  }
</style>
