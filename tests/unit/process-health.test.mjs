import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshProcessHealth } from '../../scripts/lib/process-health.mjs';

test('watchdog preserves stream errors and detects stale finalized segments', () => {
  const now = 1_000_000;
  const interrupted = {
    id: 'patrol-recorder-stream:driveway_main',
    expectedEveryMs: 90_000,
    lastAliveAtMs: now - 1_000,
    lastEventType: 'recording.stream.interrupted',
    health: 'error',
    detail: 'upstream unavailable'
  };
  assert.equal(refreshProcessHealth(interrupted, null, now).health, 'error');
  assert.equal(
    refreshProcessHealth({
      ...interrupted,
      lastAliveAtMs: now - 91_000,
      lastEventType: 'recording.segment.observed',
      health: 'ok'
    }, null, now).health,
    'stale'
  );
});
