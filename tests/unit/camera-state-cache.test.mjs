import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadCachedHistorySelection,
  persistCachedHistorySelection
} from '../../src/lib/client/camera-state-cache.ts';

test('history selection cache keeps recent investigations and expires old ones', () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value)
    }
  };

  try {
    const nowMs = Date.UTC(2026, 7, 6, 12);
    const investigationTimeMs = Date.UTC(2026, 5, 27, 16, 30);

    persistCachedHistorySelection(investigationTimeMs, nowMs - 2 * 60 * 60 * 1000);
    assert.equal(loadCachedHistorySelection(nowMs), investigationTimeMs);

    persistCachedHistorySelection(investigationTimeMs, nowMs - 3 * 60 * 60 * 1000 - 1);
    assert.equal(loadCachedHistorySelection(nowMs), null);
    assert.equal(values.has('patrol.history_selection.v1'), false);
  } finally {
    delete globalThis.window;
  }
});
