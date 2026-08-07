import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { appendProcessExited, startProcessHeartbeats } from './lib/patrol-events.mjs';
import { materializeGo2rtcConfig } from './write-go2rtc-config.mjs';

const configPath = await materializeGo2rtcConfig();
let configText = await readConfig(configPath);
const heartbeat = startProcessHeartbeats({
  processId: 'patrol-go2rtc',
  label: 'go2rtc stream server',
  kind: 'server',
  detail: `Serving streams from ${configPath}`
});
const configRefreshMs = Number(process.env.PATROL_GO2RTC_CONFIG_REFRESH_MS ?? '10000');
let restartingForConfig = false;
let shuttingDown = false;
let refreshInFlight = false;

let child = startGo2rtc(configPath);
let refresh = setInterval(() => {
  void refreshConfigIfIdle();
}, configRefreshMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    clearInterval(refresh);
    child.kill(signal);
  });
}

function startGo2rtc(path) {
  const childProcess = spawn('go2rtc', ['-c', path], {
    stdio: 'inherit'
  });

  childProcess.on('exit', (exitCode, signal) => {
    if (restartingForConfig && !shuttingDown) {
      restartingForConfig = false;
      child = startGo2rtc(configPath);
      return;
    }

    clearInterval(refresh);
    clearInterval(heartbeat);
    void appendProcessExited({
      processId: 'patrol-go2rtc',
      label: 'go2rtc stream server',
      kind: 'server',
      exitCode,
      signal,
      detail: `go2rtc exited after serving ${configPath}`
    }).finally(() => {
      if (signal) {
        globalThis.process.exit(128 + signalNumber(signal));
        return;
      }
      globalThis.process.exit(exitCode ?? 0);
    });
  });

  return childProcess;
}

async function refreshConfigIfIdle() {
  if (refreshInFlight || shuttingDown) {
    return;
  }
  refreshInFlight = true;
  try {
    const nextConfigPath = await materializeGo2rtcConfig();
    const nextConfigText = await readConfig(nextConfigPath);
    if (nextConfigText === configText) {
      return;
    }

    configText = nextConfigText;
    restartingForConfig = true;
    child.kill('SIGTERM');
  } catch (error) {
    console.error('go2rtc config refresh failed:', error);
  } finally {
    refreshInFlight = false;
  }
}

async function readConfig(path) {
  return await readFile(path, 'utf8');
}

function signalNumber(signal) {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    default:
      return 1;
  }
}
