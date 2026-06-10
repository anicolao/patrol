import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(repoRoot, '.patrol');
const envFile = process.env.PATROL_WATCHDOG_ENV_FILE ?? path.join(dataRoot, 'watchdog.env');
const logDir = path.join(dataRoot, 'logs');
const logFile = path.join(logDir, 'watchdog.log');
const loopScript = path.join(dataRoot, 'watchdog-loop.sh');
const loopPidFile = path.join(dataRoot, 'watchdog-loop.pid');
const launchAgentPath = path.join(homedir(), 'Library', 'LaunchAgents', 'com.patrol.watchdog.plist');
const marker = '# patrol-watchdog';
const nixPath = process.env.PATROL_NIX_BIN ?? findExecutable('nix');

if (!nixPath) {
  throw new Error('Could not find nix. Set PATROL_NIX_BIN to the absolute nix executable path.');
}

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await mkdir(logDir, { recursive: true, mode: 0o700 });
await ensureEnvFile();
await validateEnvFile();

const command = [
  'cd',
  shellQuote(repoRoot),
  '&&',
  `PATROL_WATCHDOG_ENV_FILE=${shellQuote(envFile)}`,
  shellQuote(nixPath),
  'develop',
  '--command',
  'patrol-watchdog',
  '>>',
  shellQuote(logFile),
  '2>&1',
  marker
].join(' ');
const cronLine = `* * * * * ${command}`;

const current = currentCrontab();
const nextLines = current
  .split('\n')
  .filter((line) => line.trim() && !line.includes(marker));
nextLines.push(cronLine);
const next = `${nextLines.join('\n')}\n`;

const install = spawnSync('crontab', ['-'], {
  input: next,
  encoding: 'utf8'
});

if (install.status !== 0) {
  if (process.platform === 'darwin') {
    await installLaunchAgent(install.stderr);
  } else {
    throw new Error(`crontab install failed: ${install.stderr}`);
  }
} else {
  console.log(`Installed Patrol watchdog cron: ${cronLine}`);
  console.log(`Watchdog environment: ${envFile}`);
  console.log(`Watchdog log: ${logFile}`);
}

async function installLaunchAgent(crontabError) {
  await mkdir(path.dirname(launchAgentPath), { recursive: true });
  await writeFile(launchAgentPath, renderLaunchAgent(), { encoding: 'utf8', mode: 0o644 });

  const domain = launchdDomain();
  spawnSync('launchctl', ['bootout', domain, launchAgentPath], { encoding: 'utf8' });
  const bootstrap = spawnSync('launchctl', ['bootstrap', domain, launchAgentPath], { encoding: 'utf8' });
  if (bootstrap.status !== 0) {
    await installNohupLoop({
      crontabError,
      launchdError: bootstrap.stderr
    });
    return;
  }
  const enable = spawnSync('launchctl', ['enable', `${domain}/com.patrol.watchdog`], { encoding: 'utf8' });
  if (enable.status !== 0) {
    throw new Error(`launchctl enable failed: ${enable.stderr}`);
  }

  console.log(`crontab install failed, installed Patrol watchdog LaunchAgent instead: ${launchAgentPath}`);
  console.log(`Watchdog command: ${nixPath} develop --command patrol-watchdog`);
  console.log(`Watchdog environment: ${envFile}`);
  console.log(`Watchdog log: ${logFile}`);
}

async function installNohupLoop(errors) {
  const existingPid = await readExistingPid();
  if (existingPid) {
    spawnSync('kill', [String(existingPid)], { encoding: 'utf8' });
  }

  await writeFile(loopScript, renderLoopScript(), { encoding: 'utf8', mode: 0o700 });
  const start = spawnSync('/bin/sh', ['-c', `nohup ${shellQuote(loopScript)} >> ${shellQuote(logFile)} 2>&1 & echo $!`], {
    encoding: 'utf8'
  });
  if (start.status !== 0) {
    throw new Error(`watchdog loop start failed: ${start.stderr}`);
  }

  const pid = start.stdout.trim();
  await writeFile(loopPidFile, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });

  console.log('crontab install failed:');
  console.log(errors.crontabError.trim());
  console.log('launchd install failed:');
  console.log(errors.launchdError.trim());
  console.log(`Installed detached Patrol watchdog loop: ${loopScript}`);
  console.log(`Watchdog loop pid: ${pid}`);
  console.log(`Watchdog environment: ${envFile}`);
  console.log(`Watchdog log: ${logFile}`);
}

async function readExistingPid() {
  try {
    const pid = Number((await readFile(loopPidFile, 'utf8')).trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function renderLoopScript() {
  return `#!/bin/sh
cd ${shellQuote(repoRoot)} || exit 1
while true; do
  PATROL_WATCHDOG_ENV_FILE=${shellQuote(envFile)} ${shellQuote(nixPath)} develop --command patrol-watchdog
  sleep 60
done
`;
}

function launchdDomain() {
  const uid = process.getuid();
  const guiDomain = `gui/${uid}`;
  const gui = spawnSync('launchctl', ['print', guiDomain], { encoding: 'utf8' });
  if (gui.status === 0) {
    return guiDomain;
  }

  return `user/${uid}`;
}

function renderLaunchAgent() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.patrol.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nixPath)}</string>
    <string>develop</string>
    <string>--command</string>
    <string>patrol-watchdog</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATROL_WATCHDOG_ENV_FILE</key>
    <string>${escapeXml(envFile)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

async function ensureEnvFile() {
  try {
    await readFile(envFile, 'utf8');
    return;
  } catch {
    // Create a template below.
  }

  const token = process.env.PATROL_PUSHOVER_TOKEN ?? '';
  const user = process.env.PATROL_PUSHOVER_USER ?? '';
  const content = [
    '# Patrol watchdog local secrets. This file is intentionally not committed.',
    `PATROL_PUSHOVER_TOKEN=${token}`,
    `PATROL_PUSHOVER_USER=${user}`,
    'PATROL_WATCHDOG_HEALTH_URL=http://127.0.0.1:5184/api/system/heartbeat',
    'PATROL_WATCHDOG_NOTIFY_COOLDOWN_MS=900000',
    'PATROL_PUSHOVER_SOUND=bugle',
    ''
  ].join('\n');
  await writeFile(envFile, content, { encoding: 'utf8', mode: 0o600 });
}

async function validateEnvFile() {
  const values = parseEnv(await readFile(envFile, 'utf8'));
  if (!values.PATROL_PUSHOVER_TOKEN || !values.PATROL_PUSHOVER_USER) {
    throw new Error(
      `${envFile} must set PATROL_PUSHOVER_TOKEN and PATROL_PUSHOVER_USER before installing cron`
    );
  }
}

function parseEnv(content) {
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim().replace(/^"|"$/g, '');
  }
  return values;
}

function currentCrontab() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) {
    return result.stdout;
  }
  if (result.stderr.includes('no crontab')) {
    return '';
  }
  throw new Error(`crontab -l failed: ${result.stderr}`);
}

function findExecutable(name) {
  const result = spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
