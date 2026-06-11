import { json } from '@sveltejs/kit';
import { appendPersonRecognitionSampleDismissed } from '$lib/server/camera-events';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function POST({ request }) {
  const body = await request.json();
  const sampleId = stringField(body, 'sampleId');

  if (!sampleId) {
    return json({ error: 'sampleId is required.' }, { status: 400 });
  }

  await appendPersonRecognitionSampleDismissed({ sampleId });

  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || !(field in value)) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue.trim() : null;
}
