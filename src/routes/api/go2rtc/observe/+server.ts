import { json } from '@sveltejs/kit';
import {
  appendGo2rtcObservationRequested
} from '$lib/server/camera-events';
import { DEFAULT_GO2RTC_API_BASE_URL, observeGo2rtcStreams } from '$lib/server/go2rtc-observer';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function POST() {
  const apiBaseUrl = process.env.PATROL_GO2RTC_API_BASE_URL ?? DEFAULT_GO2RTC_API_BASE_URL;
  await appendGo2rtcObservationRequested({ apiBaseUrl });
  await observeGo2rtcStreams(apiBaseUrl);
  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}
