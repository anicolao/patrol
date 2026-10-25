import assert from 'node:assert/strict';
import test from 'node:test';
import { delay } from '../../scripts/lib/async.mjs';

test('delay resolves asynchronously', async () => {
  let resolved = false;
  const waiting = delay(0).then(() => {
    resolved = true;
  });

  assert.equal(resolved, false);
  await waiting;
  assert.equal(resolved, true);
});
