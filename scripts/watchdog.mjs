import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendProcessHeartbeat,
  appendSystemEvent
} from './lib/patrol-events.mjs';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const envFile = process.env.PATROL_WATCHDOG_ENV_FILE ?? path.join(dataRoot, 'watchdog.env');
const stateFile = process.env.PATROL_WATCHDOG_STATE_FILE ?? path.join(dataRoot, 'watchdog-state.json');
const healthUrl = process.env.PATROL_WATCHDOG_HEALTH_URL ?? 'http://127.0.0.1:5184/api/system/heartbeat';
const timeoutMs = Number(process.env.PATROL_WATCHDOG_TIMEOUT_MS ?? '10000');
const notificationCooldownMs = Number(process.env.PATROL_WATCHDOG_NOTIFY_COOLDOWN_MS ?? '900000');

await loadEnvFile(envFile);

await appendProcessHeartbeat({
  processId: 'patrol-watchdog',
  label: 'Watchdog cron',
  kind: 'worker',
  detail: 'Verifies server task health and sends failure notifications'
});

const previousState = await readState();
const check = await checkPatrolHealth();
const signature = check.ok ? 'ok' : check.failures.map((failure) => `${failure.id}:${failure.health}`).join('|');
const notifyFailure = !check.ok && shouldNotify(previousState, signature);
const notifyRecovery =
  check.ok &&
  previousState.status === 'failure' &&
  process.env.PATROL_WATCHDOG_NOTIFY_RECOVERY !== '0' &&
  process.env.PATROL_WATCHDOG_DRY_RUN !== '1';

await appendSystemEvent({
  type: 'system.watchdog.check_completed',
  source: 'patrol-watchdog',
  payload: {
    ok: check.ok,
    healthUrl,
    greenCount: check.greenCount,
    totalCount: check.totalCount,
    failures: check.failures
  }
});

if (notifyFailure) {
  await sendPushoverNotification(failureMessage(check));
  await appendSystemEvent({
    type: 'system.watchdog.notification_sent',
    source: 'patrol-watchdog',
    payload: {
      reason: 'failure',
      signature,
      failures: check.failures
    }
  });
}

if (notifyRecovery) {
  await sendPushoverNotification('Patrol recovered: all security services are green.', 0);
  await appendSystemEvent({
    type: 'system.watchdog.notification_sent',
    source: 'patrol-watchdog',
    payload: {
      reason: 'recovery',
      signature: 'ok',
      failures: []
    }
  });
}

await writeState({
  status: check.ok ? 'ok' : 'failure',
  signature,
  lastCheckedAtMs: Date.now(),
  lastNotificationAtMs: notifyFailure || notifyRecovery ? Date.now() : previousState.lastNotificationAtMs ?? null
});

if (!check.ok) {
  console.error(failureMessage(check));
  process.exitCode = 1;
}

async function checkPatrolHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: 'POST',
      signal: controller.signal
    });
    if (!response.ok) {
      return failedCheck([
        {
          id: 'patrol-web',
          label: 'Patrol web/API server',
          health: 'error',
          detail: `Health endpoint returned HTTP ${response.status}`,
          lastAliveAtMs: null
        }
      ]);
    }

    const body = await response.json();
    const processes = Array.isArray(body.processes) ? body.processes : [];
    if (processes.length === 0) {
      return failedCheck([
        {
          id: 'patrol-system',
          label: 'Patrol system state',
          health: 'missing',
          detail: 'Health endpoint returned no process state',
          lastAliveAtMs: null
        }
      ]);
    }

    const failures = processes
      .filter((process) => process.health !== 'ok')
      .map((process) => ({
        id: String(process.id ?? 'unknown'),
        label: String(process.label ?? process.id ?? 'Unknown process'),
        health: String(process.health ?? 'missing'),
        detail: process.detail ? String(process.detail) : null,
        lastAliveAtMs: typeof process.lastAliveAtMs === 'number' ? process.lastAliveAtMs : null
      }));

    return {
      ok: failures.length === 0,
      greenCount: processes.length - failures.length,
      totalCount: processes.length,
      failures
    };
  } catch (error) {
    return failedCheck([
      {
        id: 'patrol-web',
        label: 'Patrol web/API server',
        health: 'error',
        detail: error instanceof Error ? error.message : String(error),
        lastAliveAtMs: null
      }
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function failedCheck(failures) {
  return {
    ok: false,
    greenCount: 0,
    totalCount: failures.length,
    failures
  };
}

function shouldNotify(previousState, signature) {
  if (process.env.PATROL_WATCHDOG_DRY_RUN === '1') {
    return false;
  }

  if (previousState.status !== 'failure') {
    return true;
  }

  if (previousState.signature !== signature) {
    return true;
  }

  const lastNotificationAtMs = previousState.lastNotificationAtMs ?? 0;
  return Date.now() - lastNotificationAtMs >= notificationCooldownMs;
}

async function sendPushoverNotification(message, priority = 1) {
  const token = process.env.PATROL_PUSHOVER_TOKEN;
  const user = process.env.PATROL_PUSHOVER_USER;
  if (!token || !user) {
    throw new Error('PATROL_PUSHOVER_TOKEN and PATROL_PUSHOVER_USER are required for watchdog notifications');
  }

  const params = {
    token,
    user,
    message,
    priority: String(priority),
    sound: process.env.PATROL_PUSHOVER_SOUND ?? 'bugle'
  };

  const response = await postFormWithRetry('https://api.pushover.net/1/messages.json', params);
  if (response.status !== 1) {
    throw new Error(`Pushover rejected watchdog notification: ${JSON.stringify(response)}`);
  }
}

async function postFormWithRetry(url, params) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params).toString()
      });
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }

  throw lastError;
}

function failureMessage(check) {
  const failures = check.failures
    .map((failure) => `${failure.label}: ${failure.health}${failure.detail ? ` (${failure.detail})` : ''}`)
    .join('; ');
  return `Patrol failure: ${check.greenCount}/${check.totalCount} security services are green. ${failures}`;
}

async function loadEnvFile(filePath) {
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^"|"$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return {
      status: 'unknown',
      signature: null,
      lastCheckedAtMs: null,
      lastNotificationAtMs: null
    };
  }
}

async function writeState(state) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
