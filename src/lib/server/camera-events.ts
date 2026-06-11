import type { CameraDiscoveryRawResult, CameraDiscoveryState } from '$lib/cameras/discovery';
import {
  type AnnkeAiObservationRequestedPayload,
  type AnnkeAlertStreamMessageReceivedPayload,
  type AnnkeIsapiResponseObservedPayload,
  type CameraCredentialsSavedPayload,
  type DiscoveryCompletedPayload,
  type DiscoveryInitiatedPayload,
  type Go2rtcObservationRequestedPayload,
  type Go2rtcStreamsObservedPayload,
  type PersonRecognitionSampleAnalyzedPayload,
  type PersonRecognitionSampleDismissedPayload,
  type PersonRecognitionSampleFailedPayload,
  type PersonRecognitionSampleLabeledPayload,
  type RecordingSegmentExpiredPayload,
  type RecordingSegmentObservedPayload,
  reduceCameraDiscoveryEvents
} from '$lib/cameras/state-reducer';
import { appendEvent, readEvents } from '$lib/server/event-store';
import { readSystemEvents } from '$lib/server/system-events';

const CAMERA_STREAM = 'cameras';

export async function appendDiscoveryInitiated(runId: string) {
  return await appendEvent<DiscoveryInitiatedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.initiated',
    source: 'patrol-web',
    correlation_id: runId,
    payload: {
      protocol: 'onvif-ws-discovery'
    }
  });
}

export async function appendDiscoveryCompleted(runId: string, rawResult: CameraDiscoveryRawResult) {
  return await appendEvent<DiscoveryCompletedPayload>(CAMERA_STREAM, {
    type: 'camera.discovery.completed',
    source: 'patrol-discovery',
    correlation_id: runId,
    payload: {
      rawResult
    }
  });
}

export async function appendCameraCredentialsSaved(payload: CameraCredentialsSavedPayload) {
  return await appendEvent<CameraCredentialsSavedPayload>(CAMERA_STREAM, {
    type: 'camera.credentials.saved',
    source: 'patrol-web',
    payload
  });
}

export async function appendGo2rtcObservationRequested(payload: Go2rtcObservationRequestedPayload) {
  return await appendEvent<Go2rtcObservationRequestedPayload>(CAMERA_STREAM, {
    type: 'go2rtc.observation.requested',
    source: 'patrol-web',
    payload
  });
}

export async function appendGo2rtcStreamsObserved(payload: Go2rtcStreamsObservedPayload) {
  return await appendEvent<Go2rtcStreamsObservedPayload>(CAMERA_STREAM, {
    type: 'go2rtc.streams.observed',
    source: 'patrol-go2rtc-observer',
    payload
  });
}

export async function appendAnnkeAiObservationRequested(payload: AnnkeAiObservationRequestedPayload) {
  return await appendEvent<AnnkeAiObservationRequestedPayload>(CAMERA_STREAM, {
    type: 'annke.ai.observation.requested',
    source: 'patrol-web',
    payload
  });
}

export async function appendAnnkeIsapiResponseObserved(payload: AnnkeIsapiResponseObservedPayload) {
  return await appendEvent<AnnkeIsapiResponseObservedPayload>(CAMERA_STREAM, {
    type: 'annke.isapi.response.observed',
    source: 'patrol-annke-observer',
    payload
  });
}

export async function appendAnnkeAlertStreamMessageReceived(
  payload: AnnkeAlertStreamMessageReceivedPayload
) {
  return await appendEvent<AnnkeAlertStreamMessageReceivedPayload>(CAMERA_STREAM, {
    type: 'annke.alert_stream.message_received',
    source: 'patrol-annke-events',
    payload
  });
}

export async function appendRecordingSegmentObserved(payload: RecordingSegmentObservedPayload) {
  return await appendEvent<RecordingSegmentObservedPayload>(CAMERA_STREAM, {
    type: 'recording.segment.observed',
    source: 'patrol-recorder',
    payload
  });
}

export async function appendRecordingSegmentExpired(payload: RecordingSegmentExpiredPayload) {
  return await appendEvent<RecordingSegmentExpiredPayload>(CAMERA_STREAM, {
    type: 'recording.segment.expired',
    source: 'patrol-recorder',
    payload
  });
}

export async function appendPersonRecognitionSampleAnalyzed(payload: PersonRecognitionSampleAnalyzedPayload) {
  return await appendEvent<PersonRecognitionSampleAnalyzedPayload>(CAMERA_STREAM, {
    type: 'person.recognition.sample.analyzed',
    source: 'patrol-person-recognizer',
    payload
  });
}

export async function appendPersonRecognitionSampleFailed(payload: PersonRecognitionSampleFailedPayload) {
  return await appendEvent<PersonRecognitionSampleFailedPayload>(CAMERA_STREAM, {
    type: 'person.recognition.sample.failed',
    source: 'patrol-person-recognizer',
    payload
  });
}

export async function appendPersonRecognitionSampleLabeled(payload: PersonRecognitionSampleLabeledPayload) {
  return await appendEvent<PersonRecognitionSampleLabeledPayload>(CAMERA_STREAM, {
    type: 'person.recognition.sample.labeled',
    source: 'patrol-web',
    payload
  });
}

export async function appendPersonRecognitionSampleDismissed(payload: PersonRecognitionSampleDismissedPayload) {
  return await appendEvent<PersonRecognitionSampleDismissedPayload>(CAMERA_STREAM, {
    type: 'person.recognition.sample.dismissed',
    source: 'patrol-web',
    payload
  });
}

export async function currentCameraDiscoveryState(): Promise<CameraDiscoveryState> {
  return reduceCameraDiscoveryEvents(await readEvents(CAMERA_STREAM), await readSystemEvents());
}
