export function nextWatchdogNotificationState({
  checkOk,
  signature,
  previousState,
  nowMs,
  failureGraceMs,
  recoveryGraceMs,
  notificationCooldownMs,
  dryRun = false,
  notifyRecoveryEnabled = true
}) {
  const previousStatus = previousState.status ?? 'unknown';
  const previousLastNotificationAtMs = numberOrNull(previousState.lastNotificationAtMs);

  if (!checkOk) {
    const continuingIncident = previousStatus === 'failure';
    const incidentStartedAtMs = continuingIncident
      ? numberOrNull(previousState.incidentStartedAtMs) ?? numberOrNull(previousState.lastCheckedAtMs) ?? nowMs
      : nowMs;
    const previousFailureNotificationAtMs = continuingIncident
      ? numberOrNull(previousState.lastFailureNotificationAtMs) ?? previousLastNotificationAtMs
      : null;
    const graceElapsed = nowMs - incidentStartedAtMs >= failureGraceMs;
    const cooldownElapsed =
      previousFailureNotificationAtMs === null ||
      nowMs - previousFailureNotificationAtMs >= notificationCooldownMs;
    const notifyFailure = !dryRun && graceElapsed && cooldownElapsed;

    return {
      notifyFailure,
      notifyRecovery: false,
      state: {
        status: 'failure',
        signature,
        incidentStartedAtMs,
        healthySinceAtMs: null,
        lastCheckedAtMs: nowMs,
        lastFailureNotificationAtMs: notifyFailure ? nowMs : previousFailureNotificationAtMs,
        lastNotificationAtMs: notifyFailure ? nowMs : previousLastNotificationAtMs
      }
    };
  }

  if (previousStatus !== 'failure') {
    return {
      notifyFailure: false,
      notifyRecovery: false,
      state: healthyState(signature, nowMs, previousLastNotificationAtMs)
    };
  }

  const healthySinceAtMs = numberOrNull(previousState.healthySinceAtMs) ?? nowMs;
  const recoveryConfirmed = nowMs - healthySinceAtMs >= recoveryGraceMs;
  const lastFailureNotificationAtMs =
    numberOrNull(previousState.lastFailureNotificationAtMs) ?? previousLastNotificationAtMs;
  if (!recoveryConfirmed) {
    return {
      notifyFailure: false,
      notifyRecovery: false,
      state: {
        ...previousState,
        status: 'failure',
        signature,
        healthySinceAtMs,
        lastCheckedAtMs: nowMs,
        lastFailureNotificationAtMs
      }
    };
  }

  const notifyRecovery =
    !dryRun &&
    notifyRecoveryEnabled &&
    lastFailureNotificationAtMs !== null;
  return {
    notifyFailure: false,
    notifyRecovery,
    state: healthyState(
      signature,
      nowMs,
      notifyRecovery ? nowMs : previousLastNotificationAtMs
    )
  };
}

function healthyState(signature, nowMs, lastNotificationAtMs) {
  return {
    status: 'ok',
    signature,
    incidentStartedAtMs: null,
    healthySinceAtMs: null,
    lastCheckedAtMs: nowMs,
    lastFailureNotificationAtMs: null,
    lastNotificationAtMs
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
