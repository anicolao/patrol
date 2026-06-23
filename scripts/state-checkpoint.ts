import {
  appendProcessExited,
  startProcessHeartbeats
} from './lib/patrol-events.mjs';
import { refreshCameraStateCheckpoint } from '../src/lib/server/state-cache.ts';

const processId = 'patrol-state-checkpoint';
const label = 'State checkpoint worker';
const kind = 'worker';
const refreshEveryMs = Number(process.env.PATROL_STATE_CHECKPOINT_MS ?? '60000');
const retryDelayMs = Number(process.env.PATROL_STATE_CHECKPOINT_RETRY_MS ?? '10000');
const forceFullReplay = process.env.PATROL_STATE_CHECKPOINT_FULL_REPLAY === '1';

let stopping = false;
let refreshInFlight = false;

const heartbeat = startProcessHeartbeats({
  processId,
  label,
  kind,
  detail: 'Maintains server projection checkpoints for fast state reads'
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(heartbeat);
    void appendProcessExited({
      processId,
      label,
      kind,
      exitCode: 128 + signalNumber(signal),
      signal,
      detail: 'State checkpoint worker stopped'
    }).finally(() => {
      process.exit(0);
    });
  });
}

await refreshLoop();

async function refreshLoop() {
  while (!stopping) {
    const startedAtMs = Date.now();
    try {
      await refreshCheckpoint();
      await sleep(Math.max(1000, refreshEveryMs - (Date.now() - startedAtMs)));
    } catch (error) {
      console.error('state checkpoint refresh failed:', error);
      await sleep(retryDelayMs);
    }
  }
}

async function refreshCheckpoint() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  const startedAtMs = Date.now();
  try {
    const result = await refreshCameraStateCheckpoint({ forceFullReplay });
    const durationMs = Date.now() - startedAtMs;
    console.log(
      JSON.stringify({
        event: 'state_checkpoint.refreshed',
        durationMs,
        replayedEvents: result.replayedEvents,
        fullReplay: result.fullReplay,
        cachedAtMs: result.snapshot.cachedAtMs
      })
    );
  } finally {
    refreshInFlight = false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalNumber(signal: NodeJS.Signals) {
  return signal === 'SIGINT' ? 2 : 15;
}
