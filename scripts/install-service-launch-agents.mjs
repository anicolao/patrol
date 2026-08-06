import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('The Patrol service LaunchAgent installer is only supported on macOS.');
}

const serviceDefinitions = [
  {
    id: 'web',
    label: 'com.patrol.web',
    command: 'patrol-web'
  },
  {
    id: 'events-ws',
    label: 'com.patrol.events-ws',
    command: 'patrol-events-ws'
  },
  {
    id: 'annke-events',
    label: 'com.patrol.annke-events',
    command: 'patrol-annke-events'
  },
  {
    id: 'state-checkpoint',
    label: 'com.patrol.state-checkpoint',
    command: 'patrol-state-checkpoint'
  },
  {
    id: 'person-recognizer',
    label: 'com.patrol.person-recognizer',
    command: 'patrol-person-recognizer'
  },
  {
    id: 'thumbnailer',
    label: 'com.patrol.thumbnailer',
    command: 'patrol-thumbnailer'
  }
];

const repoRoot = process.env.PATROL_SERVICES_REPO_ROOT ?? process.cwd();
const currentUser = userInfo().username;
const runAsUser = process.env.PATROL_SERVICES_RUN_AS_USER ?? currentUser;
const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(repoRoot, '.patrol');
const recordingsDir = process.env.PATROL_RECORDINGS_DIR ?? path.join(dataRoot, 'recordings');
const thumbnailDir = process.env.PATROL_THUMBNAIL_DIR ?? null;
const nixPath = process.env.PATROL_NIX_BIN ?? findExecutable('nix');
const domain = `gui/${process.getuid()}`;
const launchAgentDir = path.join(homedir(), 'Library', 'LaunchAgents');
const logDir = path.join(homedir(), 'Library', 'Logs', 'Patrol');
const requestedIds = (process.env.PATROL_LAUNCH_AGENT_SERVICES ?? serviceDefinitions.map(({ id }) => id).join(','))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const services = requestedIds.map((id) => {
  const service = serviceDefinitions.find((candidate) => candidate.id === id);
  if (!service) {
    throw new Error(
      `Unknown Patrol service ${JSON.stringify(id)}. Expected: ${serviceDefinitions.map(({ id }) => id).join(', ')}.`
    );
  }
  return service;
});

if (!nixPath) {
  throw new Error('Could not find nix. Set PATROL_NIX_BIN to the absolute nix executable path.');
}
if (services.length === 0) {
  throw new Error('No Patrol services were selected.');
}

verifyGuiDomain();
verifyServicePaths();
await mkdir(launchAgentDir, { recursive: true, mode: 0o700 });
await mkdir(logDir, { recursive: true, mode: 0o700 });

for (const service of services) {
  await installService(service);
}

async function installService(service) {
  const launchAgentPath = path.join(launchAgentDir, `${service.label}.plist`);
  const logFile = path.join(logDir, `${service.id}.log`);
  await writeFile(launchAgentPath, renderLaunchAgent(service, logFile), { encoding: 'utf8', mode: 0o644 });

  spawnSync('launchctl', ['bootout', `${domain}/${service.label}`], { encoding: 'utf8' });
  const bootstrap = spawnSync('launchctl', ['bootstrap', domain, launchAgentPath], { encoding: 'utf8' });
  if (bootstrap.status !== 0) {
    throw new Error(
      `${service.id} launchctl bootstrap failed: ${bootstrap.stderr.trim() || `exit ${bootstrap.status}`}`
    );
  }

  const enable = spawnSync('launchctl', ['enable', `${domain}/${service.label}`], { encoding: 'utf8' });
  if (enable.status !== 0) {
    throw new Error(`${service.id} launchctl enable failed: ${enable.stderr.trim() || `exit ${enable.status}`}`);
  }

  const kickstart = spawnSync('launchctl', ['kickstart', `${domain}/${service.label}`], { encoding: 'utf8' });
  if (kickstart.status !== 0) {
    throw new Error(`${service.id} launchctl kickstart failed: ${kickstart.stderr.trim() || `exit ${kickstart.status}`}`);
  }

  const installed = spawnSync('launchctl', ['print', `${domain}/${service.label}`], { encoding: 'utf8' });
  if (installed.status !== 0) {
    throw new Error(
      `${service.id} LaunchAgent verification failed: ${installed.stderr.trim() || `exit ${installed.status}`}`
    );
  }

  console.log(`Installed ${service.id}: ${launchAgentPath}`);
  console.log(`  command: ${service.command}`);
  console.log(`  runs as: ${runAsUser}`);
  console.log(`  log: ${logFile}`);
}

function verifyGuiDomain() {
  const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `No active GUI launchd domain exists for ${currentUser} (${domain}). Install from the macOS auto-login user session.`
    );
  }
}

function verifyServicePaths() {
  const testCommand = [
    '/bin/test',
    '-r',
    path.join(dataRoot, 'events'),
    '-a',
    '-w',
    path.join(dataRoot, 'events'),
    '-a',
    '-r',
    path.join(dataRoot, 'secrets'),
    '-a',
    '-w',
    dataRoot,
    '-a',
    '-r',
    recordingsDir
  ];
  const args = runAsUser === currentUser
    ? testCommand.slice(1)
    : [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=yes',
        `${runAsUser}@localhost`,
        testCommand.map(shellQuote).join(' ')
      ];
  const command = runAsUser === currentUser ? testCommand[0] : '/usr/bin/ssh';
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Patrol service paths are not accessible as ${runAsUser}: data=${dataRoot}, recordings=${recordingsDir}. ` +
      (result.stderr.trim() || `exit ${result.status}`)
    );
  }
}

function renderLaunchAgent(service, logFile) {
  const serviceArgs = [
    '/usr/bin/env',
    `PATROL_DATA_DIR=${dataRoot}`,
    `PATROL_RECORDINGS_DIR=${recordingsDir}`,
    ...(thumbnailDir ? [`PATROL_THUMBNAIL_DIR=${thumbnailDir}`] : []),
    nixPath,
    'develop',
    '--command',
    service.command
  ];
  const programArguments = runAsUser === currentUser
    ? serviceArgs
    : [
        '/usr/bin/ssh',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StrictHostKeyChecking=yes',
        `${runAsUser}@localhost`,
        `cd ${shellQuote(repoRoot)} && exec ${serviceArgs.map(shellQuote).join(' ')}`
      ];
  const workingDirectory = runAsUser === currentUser ? repoRoot : homedir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${service.label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
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
