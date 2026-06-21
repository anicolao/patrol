import { json } from '@sveltejs/kit';
import { appendPersonRecognitionSampleDismissed } from '$lib/server/camera-events';

export async function POST({ request }) {
  const body = await request.json();
  const sampleId = stringField(body, 'sampleId');

  if (!sampleId) {
    return json({ error: 'sampleId is required.' }, { status: 400 });
  }

  const event = await appendPersonRecognitionSampleDismissed({ sampleId });

  return json({
    accepted: true,
    events: [event]
  });
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || !(field in value)) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue.trim() : null;
}
