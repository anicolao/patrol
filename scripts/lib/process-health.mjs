export function refreshProcessHealth(process, recentEvent, nowMs = Date.now()) {
  const storedLastAliveAtMs = typeof process.lastAliveAtMs === 'number' ? process.lastAliveAtMs : null;
  const useRecentEvent = recentEvent && (storedLastAliveAtMs === null || recentEvent.tsMs >= storedLastAliveAtMs);
  const lastAliveAtMs = useRecentEvent ? recentEvent.tsMs : storedLastAliveAtMs;
  const expectedEveryMs = Number(process.expectedEveryMs ?? 90_000);
  const eventType = useRecentEvent ? recentEvent.eventType : process.lastEventType;
  const preserveReportedError = !useRecentEvent && process.health === 'error';
  const health =
    eventType === 'system.process.exited' || preserveReportedError
      ? 'error'
      : lastAliveAtMs === null
        ? 'missing'
        : nowMs - lastAliveAtMs > expectedEveryMs
          ? 'stale'
          : 'ok';

  return {
    ...process,
    lastAliveAtMs,
    health,
    detail: useRecentEvent && recentEvent.detail ? recentEvent.detail : process.detail
  };
}
