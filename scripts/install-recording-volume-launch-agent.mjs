import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('The Patrol recording-volume LaunchAgent installer is only supported on macOS.');
}

const volumeUuid = process.env.PATROL_RECORDING_VOLUME_UUID;
if (!volumeUuid || !/^[0-9A-Fa-f-]{36}$/.test(volumeUuid)) {
  throw new Error('Set PATROL_RECORDING_VOLUME_UUID to the NVR APFS volume UUID.');
}

const currentUser = userInfo().username;
const label = 'com.patrol.recording-volume';
const domain = `gui/${process.getuid()}`;
const launchAgentDir = path.join(homedir(), 'Library', 'LaunchAgents');
const launchAgentPath = path.join(launchAgentDir, `${label}.plist`);
const logDir = path.join(homedir(), 'Library', 'Logs', 'Patrol');
const logFile = path.join(logDir, 'recording-volume.log');

verifyGuiDomain();
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
const kickstart = spawnSync('launchctl', ['kickstart', `${domain}/${label}`], { encoding: 'utf8' });
if (kickstart.status !== 0) {
  throw new Error(`launchctl kickstart failed: ${kickstart.stderr.trim() || `exit ${kickstart.status}`}`);
}

console.log(`Installed Patrol recording-volume LaunchAgent: ${launchAgentPath}`);
console.log(`LaunchAgent domain: ${domain}`);
console.log(`Volume UUID: ${volumeUuid}`);
console.log(`Recording-volume log: ${logFile}`);

function verifyGuiDomain() {
  const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `No active GUI launchd domain exists for ${currentUser} (${domain}). Install from the macOS auto-login user session.`
    );
  }
}

function renderLaunchAgent() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>/usr/sbin/diskutil info ${volumeUuid} | /usr/bin/grep -q 'Mounted: *Yes' || exec /usr/sbin/diskutil mount ${volumeUuid}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}
