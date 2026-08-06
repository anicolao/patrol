import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('The Patrol watchdog LaunchAgent installer is only supported on macOS.');
}

const repoRoot = process.env.PATROL_WATCHDOG_REPO_ROOT ?? process.cwd();
const currentUser = userInfo().username;
const runAsUser = process.env.PATROL_WATCHDOG_RUN_AS_USER ?? currentUser;
const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(repoRoot, '.patrol');
const envFile = process.env.PATROL_WATCHDOG_ENV_FILE ?? path.join(dataRoot, 'watchdog.env');
const nixPath = process.env.PATROL_NIX_BIN ?? findExecutable('nix');
const label = 'com.patrol.watchdog';
const domain = `gui/${process.getuid()}`;
const launchAgentDir = path.join(homedir(), 'Library', 'LaunchAgents');
const launchAgentPath = path.join(launchAgentDir, `${label}.plist`);
const logDir = path.join(homedir(), 'Library', 'Logs', 'Patrol');
const logFile = path.join(logDir, 'watchdog.log');

if (!nixPath) {
  throw new Error('Could not find nix. Set PATROL_NIX_BIN to the absolute nix executable path.');
}

verifyGuiDomain();
verifyWatchdogEnvironment();
await mkdir(launchAgentDir, { recursive: true, mode: 0o700 });
await mkdir(logDir, { recursive: true, mode: 0o700 });
await writeFile(launchAgentPath, renderLaunchAgent(), { encoding: 'utf8', mode: 0o644 });

spawnSync('launchctl', ['bootout', `${domain}/${label}`], { encoding: 'utf8' });
const bootstrap = spawnSync('launchctl', ['bootstrap', domain, launchAgentPath], { encoding: 'utf8' });
if (bootstrap.status !== 0) {
  throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || `exit ${bootstrap.status}`}`);
}

const enable = spawnSync('launchctl', ['enable', `${domain}/${label}`], { encoding: 'utf8' });
if (enable.status !== 0) {
  throw new Error(`launchctl enable failed: ${enable.stderr.trim() || `exit ${enable.status}`}`);
}

const kickstart = spawnSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], { encoding: 'utf8' });
if (kickstart.status !== 0) {
  throw new Error(`launchctl kickstart failed: ${kickstart.stderr.trim() || `exit ${kickstart.status}`}`);
}

const installed = spawnSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
if (installed.status !== 0) {
  throw new Error(`LaunchAgent verification failed: ${installed.stderr.trim() || `exit ${installed.status}`}`);
}

console.log(`Installed Patrol watchdog LaunchAgent: ${launchAgentPath}`);
console.log(`LaunchAgent domain: ${domain}`);
console.log(`Watchdog runs as: ${runAsUser}`);
console.log(`Watchdog environment: ${envFile}`);
console.log(`Watchdog log: ${logFile}`);

function verifyGuiDomain() {
  const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `No active GUI launchd domain exists for ${currentUser} (${domain}). Install from the macOS auto-login user session.`
    );
  }
}

function verifyWatchdogEnvironment() {
  const args = runAsUser === currentUser
    ? ['/bin/test', '-r', envFile]
    : [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=yes',
        `${runAsUser}@localhost`,
        `/bin/test -r ${shellQuote(envFile)}`
      ];
  const command = runAsUser === currentUser ? args.shift() : '/usr/bin/ssh';
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Watchdog environment is not readable as ${runAsUser}: ${envFile}. ` +
      (result.stderr.trim() || `exit ${result.status}`)
    );
  }
}

function renderLaunchAgent() {
  const watchdogArgs = [
    '/usr/bin/env',
    `PATROL_DATA_DIR=${dataRoot}`,
    `PATROL_WATCHDOG_ENV_FILE=${envFile}`,
    nixPath,
    'develop',
    '--command',
    'patrol-watchdog'
  ];
  const programArguments = runAsUser === currentUser
    ? watchdogArgs
    : [
        '/usr/bin/ssh',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=yes',
        `${runAsUser}@localhost`,
        `cd ${shellQuote(repoRoot)} && exec ${watchdogArgs.map(shellQuote).join(' ')}`
      ];
  const workingDirectory = runAsUser === currentUser ? repoRoot : homedir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function findExecutable(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
