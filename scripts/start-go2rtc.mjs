import { spawn } from 'node:child_process';
import { appendProcessExited, startProcessHeartbeats } from './lib/patrol-events.mjs';

const configPath = await materializeConfig();
const heartbeat = startProcessHeartbeats({
  processId: 'patrol-go2rtc',
  label: 'go2rtc stream server',
  kind: 'server',
  detail: `Serving streams from ${configPath}`
});

const child = spawn('go2rtc', ['-c', configPath], {
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (exitCode, signal) => {
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
      process.exit(128 + signalNumber(signal));
      return;
    }
    process.exit(exitCode ?? 0);
  });
});

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
