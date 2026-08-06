import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openRecordingCatalog,
  syncRecordingCatalogFromEvents
} from '../../src/lib/server/recording-catalog.ts';

test('catalog queries windows, bounds, expiration, and incremental event sync', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'patrol-recording-catalog-'));
  const eventsDir = path.join(dataRoot, 'events');
  await mkdir(eventsDir);
  const eventFile = path.join(eventsDir, 'cameras-2026-08-06.jsonl');
  const first = observedEvent('main/100.mp4', 100_000, 'main');
  const second = observedEvent('sub/110.mp4', 110_000, 'sub');
  await writeFile(eventFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

  const catalog = await openRecordingCatalog(dataRoot);
  try {
    assert.deepEqual(await syncRecordingCatalogFromEvents(catalog, eventsDir), {
      filesRead: 1,
      eventsApplied: 2
    });
    assert.deepEqual(
      catalog.segmentsForWindow(['camera_main', 'camera_sub'], 105_000, 120_000).map(({ relativePath }) => relativePath),
      ['sub/110.mp4', 'main/100.mp4']
    );
    assert.deepEqual(catalog.availableBounds(['camera_main', 'camera_sub']), {
      availableStartMs: 100_000,
      availableEndMs: 125_000
    });
    assert.deepEqual(catalog.summary(), {
      total_segments: 2,
      active_segments: 2,
      available_start_ms: 100_000,
      available_end_ms: 125_000
    });

    await writeFile(
      eventFile,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(expiredEvent('main/100.mp4'))}\n`
    );
    assert.deepEqual(await syncRecordingCatalogFromEvents(catalog, eventsDir), {
      filesRead: 1,
      eventsApplied: 1
    });
    assert.deepEqual(
      catalog.segmentsForWindow(['camera_main', 'camera_sub'], 0, 200_000).map(({ relativePath }) => relativePath),
      ['sub/110.mp4']
    );
    assert.deepEqual(await syncRecordingCatalogFromEvents(catalog, eventsDir), {
      filesRead: 0,
      eventsApplied: 0
    });
  } finally {
    catalog.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function observedEvent(relativePath, startMs, role) {
  return {
    id: `observed-${relativePath}`,
    ts_ms: startMs + 16_000,
    schema: 1,
    type: 'recording.segment.observed',
    source: 'patrol-recorder',
    payload: {
      cameraId: 'camera-1',
      role,
      streamName: `camera_${role}`,
      startMs,
      durationMs: 15_000,
      sizeBytes: 1024,
      relativePath
    }
  };
}

function expiredEvent(relativePath) {
  return {
    id: `expired-${relativePath}`,
    ts_ms: 200_000,
    schema: 1,
    type: 'recording.segment.expired',
    source: 'patrol-recorder',
    payload: { relativePath }
  };
}
