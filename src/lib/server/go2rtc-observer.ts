import { appendGo2rtcStreamsObserved } from '$lib/server/camera-events';

export const DEFAULT_GO2RTC_API_BASE_URL = 'http://127.0.0.1:1984';

export async function observeGo2rtcStreams(
  apiBaseUrl = process.env.PATROL_GO2RTC_API_BASE_URL ?? DEFAULT_GO2RTC_API_BASE_URL
) {
  const startedAtMs = Date.now();
  let statusCode: number | null = null;
  let body: string | null = null;
  let error: string | null = null;
  let ok = false;

  try {
    const response = await fetch(new URL('/api/streams', apiBaseUrl));
    statusCode = response.status;
    const responseBody = await response.text();
    body = redactRtspCredentials(responseBody);
    ok = response.ok;
    if (!response.ok) {
      error = `go2rtc /api/streams returned HTTP ${response.status}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return await appendGo2rtcStreamsObserved({
    rawResult: {
      apiBaseUrl,
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
      ok,
      statusCode,
      body,
      error
    }
  });
}

export function redactRtspCredentials(value: string) {
  return value.replace(/rtsp:\/\/[^@\s"]+@/g, 'rtsp://[credentials]@');
}
