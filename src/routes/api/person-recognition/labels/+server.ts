import { json } from '@sveltejs/kit';
import { appendPersonRecognitionSampleLabeled } from '$lib/server/camera-events';
import { currentCameraStateSnapshot } from '$lib/server/state-cache';

export async function POST({ request }) {
  const body = await request.json();
  const sampleIds = sampleIdsFromBody(body);
  const label = stringField(body, 'label');

  if (sampleIds.length === 0 || !label) {
    return json({ error: 'sampleId or sampleIds and label are required.' }, { status: 400 });
  }

  for (const sampleId of sampleIds) {
    await appendPersonRecognitionSampleLabeled({
      sampleId,
      label
    });
  }

  return json(await currentCameraStateSnapshot({ forceRefresh: true }));
}

function sampleIdsFromBody(value: unknown) {
  const sampleId = stringField(value, 'sampleId');
  if (sampleId) {
    return [sampleId];
  }

  if (!value || typeof value !== 'object' || !('sampleIds' in value)) {
    return [];
  }

  const sampleIds = (value as Record<string, unknown>).sampleIds;
  if (!Array.isArray(sampleIds)) {
    return [];
  }

  return sampleIds
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || !(field in value)) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.trim() ? fieldValue.trim() : null;
}
