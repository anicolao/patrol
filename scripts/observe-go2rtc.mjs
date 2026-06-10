import { appendCameraEvent } from './lib/patrol-events.mjs';

const apiBaseUrl = process.env.PATROL_GO2RTC_API_BASE_URL ?? 'http://127.0.0.1:1984';
const startedAtMs = Date.now();
let statusCode = null;
let body = null;
let error = null;
let ok = false;

try {
  const response = await fetch(new URL('/api/streams', apiBaseUrl));
  statusCode = response.status;
  body = redactRtspCredentials(await response.text());
  ok = response.ok;
  if (!response.ok) {
    error = `go2rtc /api/streams returned HTTP ${response.status}`;
  }
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}

await appendCameraEvent({
  type: 'go2rtc.streams.observed',
  source: 'patrol-go2rtc-observer',
  payload: {
    rawResult: {
      apiBaseUrl,
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
      ok,
      statusCode,
      body,
      error
    }
  }
});

if (!ok) {
  console.error(error ?? `go2rtc observation failed with HTTP ${statusCode}`);
  process.exitCode = 1;
}

function redactRtspCredentials(value) {
  return value.replace(/rtsp:\/\/[^@\s"]+@/g, 'rtsp://[credentials]@');
}
