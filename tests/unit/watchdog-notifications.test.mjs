import assert from 'node:assert/strict';
import test from 'node:test';
import { nextWatchdogNotificationState } from '../../scripts/lib/watchdog-notifications.mjs';

const policy = {
  failureGraceMs: 180_000,
  recoveryGraceMs: 120_000,
  notificationCooldownMs: 900_000
};

test('transient failures do not notify before the grace period', () => {
  const first = decide({ checkOk: false, signature: 'camera-a:error', nowMs: 1_000, previousState: healthy() });
  assert.equal(first.notifyFailure, false);
  assert.equal(first.state.incidentStartedAtMs, 1_000);

  const recovered = decide({ checkOk: true, signature: 'ok', nowMs: 61_000, previousState: first.state });
  assert.equal(recovered.notifyRecovery, false);
  assert.equal(recovered.state.status, 'failure');

  const confirmed = decide({ checkOk: true, signature: 'ok', nowMs: 181_000, previousState: recovered.state });
  assert.equal(confirmed.notifyRecovery, false);
  assert.equal(confirmed.state.status, 'ok');
});

test('changing failure signatures do not bypass grace or cooldown', () => {
  const first = decide({ checkOk: false, signature: 'camera-a:error', nowMs: 1_000, previousState: healthy() });
  const changed = decide({ checkOk: false, signature: 'camera-b:stale', nowMs: 121_000, previousState: first.state });
  assert.equal(changed.notifyFailure, false);

  const notified = decide({ checkOk: false, signature: 'camera-c:error', nowMs: 181_000, previousState: changed.state });
  assert.equal(notified.notifyFailure, true);

  const changedAgain = decide({ checkOk: false, signature: 'camera-a:stale', nowMs: 241_000, previousState: notified.state });
  assert.equal(changedAgain.notifyFailure, false);

  const cooldownElapsed = decide({ checkOk: false, signature: 'camera-b:error', nowMs: 1_081_000, previousState: changedAgain.state });
  assert.equal(cooldownElapsed.notifyFailure, true);
});

test('recovery notification requires stable health and a notified incident', () => {
  const failure = decide({
    checkOk: false,
    signature: 'camera-a:error',
    nowMs: 181_000,
    previousState: { ...healthy(), status: 'failure', incidentStartedAtMs: 0, lastCheckedAtMs: 120_000 }
  });
  assert.equal(failure.notifyFailure, true);

  const recovering = decide({ checkOk: true, signature: 'ok', nowMs: 241_000, previousState: failure.state });
  assert.equal(recovering.notifyRecovery, false);

  const flapped = decide({ checkOk: false, signature: 'camera-b:error', nowMs: 301_000, previousState: recovering.state });
  assert.equal(flapped.state.incidentStartedAtMs, 0);
  assert.equal(flapped.notifyFailure, false);

  const recoveringAgain = decide({ checkOk: true, signature: 'ok', nowMs: 361_000, previousState: flapped.state });
  const recovered = decide({ checkOk: true, signature: 'ok', nowMs: 481_000, previousState: recoveringAgain.state });
  assert.equal(recovered.notifyRecovery, true);
  assert.equal(recovered.state.status, 'ok');
});

function decide(input) {
  return nextWatchdogNotificationState({ ...policy, ...input });
}

function healthy() {
  return {
    status: 'ok',
    signature: 'ok',
    incidentStartedAtMs: null,
    healthySinceAtMs: null,
    lastCheckedAtMs: 0,
    lastFailureNotificationAtMs: null,
    lastNotificationAtMs: null
  };
}
