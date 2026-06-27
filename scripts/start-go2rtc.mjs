import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { appendProcessExited, startProcessHeartbeats } from './lib/patrol-events.mjs';

const configPath = await materializeConfig();
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

let child = startGo2rtc(configPath);
let refresh = setInterval(() => {
  void refreshConfig();
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

async function refreshConfig() {
  const nextConfigPath = await materializeConfig();
  const nextConfigText = await readConfig(nextConfigPath);
  if (nextConfigText === configText) {
    return;
  }

  configText = nextConfigText;
  restartingForConfig = true;
  child.kill('SIGTERM');
}

async function readConfig(path) {
  return await readFile(path, 'utf8');
}

async function materializeConfig() {
  const childProcess = spawn(process.execPath, ['scripts/write-go2rtc-config.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let stdout = '';
  childProcess.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  const exitCode = await new Promise((resolve) => {
    childProcess.on('exit', resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`go2rtc config materialization failed with exit code ${exitCode}`);
  }

  const configPath = stdout.trim().split('\n').at(-1);
  if (!configPath) {
    throw new Error('go2rtc config materialization did not print a config path');
  }

  return configPath;
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
