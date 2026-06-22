import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? process.env.PATROL_HIKVISION_ACTIVATE_HOST ?? '192.168.1.64';
const username = args.username ?? process.env.PATROL_HIKVISION_ACTIVATE_USERNAME ?? 'admin';
const password = await resolvePassword(args);
const timeoutSeconds = Number(args.timeout ?? process.env.PATROL_HIKVISION_ACTIVATE_TIMEOUT_SECONDS ?? '10');
const interfaceName = args.interface ?? process.env.PATROL_HIKVISION_ACTIVATE_INTERFACE ?? null;
const aliasAddress = args.alias ?? process.env.PATROL_HIKVISION_ACTIVATE_ALIAS ?? '192.168.1.100';
const aliasNetmask = args.netmask ?? process.env.PATROL_HIKVISION_ACTIVATE_NETMASK ?? '255.255.255.0';
const shouldAddAlias = Boolean(args['add-alias'] ?? process.env.PATROL_HIKVISION_ACTIVATE_ADD_ALIAS);
const shouldEnableDhcp = !args['skip-dhcp'];
const dryRun = Boolean(args['dry-run']);
const networkInterfaceId = args['network-interface-id'] ?? process.env.PATROL_HIKVISION_NETWORK_INTERFACE_ID ?? '1';

if (!password) {
  throw new Error(
    'Activation password required. Set PATROL_HIKVISION_ACTIVATION_PASSWORD or pass --password-stdin.'
  );
}

let aliasAdded = false;

try {
  if (shouldAddAlias) {
    if (!interfaceName) {
      throw new Error('Use --interface <name> with --add-alias, for example --interface en0.');
    }
    await addAlias();
    aliasAdded = true;
  }

  await printActivationStatus('before');
  await activateCamera();
  await printActivationStatus('after');

  if (shouldEnableDhcp) {
    await enableDhcp();
  }
} finally {
  if (aliasAdded && !args['keep-alias']) {
    await removeAlias().catch((error) => {
      console.error(`warning: failed to remove ${aliasAddress} alias from ${interfaceName}: ${error.message}`);
    });
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (['add-alias', 'keep-alias', 'password-stdin', 'skip-dhcp', 'dry-run', 'help'].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    index += 1;
  }

  if (parsed.help) {
    console.log(`Usage:
  patrol-activate-hikvision-camera [options]

Options:
  --host <ip>                  Camera activation host. Default: 192.168.1.64
  --username <name>            Admin username to configure/use. Default: admin
  --password-stdin             Read activation password from stdin
  --add-alias                  Temporarily add a 192.168.1.x address to this Mac
  --interface <name>           macOS interface for --add-alias, for example en0
  --alias <ip>                 Alias address. Default: 192.168.1.100
  --netmask <mask>             Alias netmask. Default: 255.255.255.0
  --keep-alias                 Do not remove the temporary alias after running
  --skip-dhcp                  Activate only; do not enable DHCP afterward
  --network-interface-id <id>  Hikvision ISAPI network interface id. Default: 1
  --dry-run                    Print commands that would run, but do not change camera

Password:
  PATROL_HIKVISION_ACTIVATION_PASSWORD=... patrol-activate-hikvision-camera
  printf '%s' "$PASSWORD" | patrol-activate-hikvision-camera --password-stdin
`);
    process.exit(0);
  }

  return parsed;
}

async function resolvePassword(parsed) {
  if (parsed['password-stdin']) {
    return (await readStdin()).trim();
  }
  return process.env.PATROL_HIKVISION_ACTIVATION_PASSWORD ?? '';
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data));
  });
}

async function printActivationStatus(label) {
  const response = await httpRequest({
    method: 'GET',
    url: `http://${host}/SDK/activateStatus`,
    expectOk: false
  });
  console.log(`${label} activation status: HTTP ${response.status}`);
  if (response.body.trim()) {
    console.log(redact(response.body.trim()));
  }
}

async function activateCamera() {
  const body = [
    '<ActivateInfo version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    `  <password>${escapeXml(password)}</password>`,
    '</ActivateInfo>'
  ].join('\n');

  if (dryRun) {
    console.log(`dry-run: would PUT http://${host}/ISAPI/System/activate`);
    return;
  }

  const response = await httpRequest({
    method: 'PUT',
    url: `http://${host}/ISAPI/System/activate`,
    headers: ['Content-Type: application/xml'],
    body
  });
  console.log(`activation response: HTTP ${response.status}`);
  if (response.body.trim()) {
    console.log(redact(response.body.trim()));
  }
}

async function enableDhcp() {
  const body = [
    '<IPAddress version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    '  <ipVersion>v4</ipVersion>',
    '  <addressingType>dynamic</addressingType>',
    '</IPAddress>'
  ].join('\n');

  const url = `http://${host}/ISAPI/System/Network/interfaces/${encodeURIComponent(networkInterfaceId)}/ipAddress`;

  if (dryRun) {
    console.log(`dry-run: would PUT ${url}`);
    return;
  }

  const response = await httpRequest({
    method: 'PUT',
    url,
    headers: ['Content-Type: application/xml'],
    body,
    digestAuth: {
      username,
      password
    },
    expectOk: false
  });

  console.log(`DHCP response: HTTP ${response.status}`);
  if (response.body.trim()) {
    console.log(redact(response.body.trim()));
  }
  if (response.status < 200 || response.status >= 300) {
    console.error('warning: activation may have succeeded, but DHCP was not confirmed.');
  }
}

async function addAlias() {
  console.log(`adding temporary ${aliasAddress}/${aliasNetmask} alias to ${interfaceName}`);
  await run('sudo', ['ifconfig', interfaceName, 'alias', aliasAddress, aliasNetmask]);
}

async function removeAlias() {
  console.log(`removing temporary ${aliasAddress} alias from ${interfaceName}`);
  await run('sudo', ['ifconfig', interfaceName, '-alias', aliasAddress]);
}

async function httpRequest(input) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'patrol-camera-activate-'));
  const bodyPath = path.join(tempDir, 'body.xml');
  const curlConfigPath = path.join(tempDir, 'curl.conf');
  try {
    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--max-time',
      String(timeoutSeconds),
      '--request',
      input.method,
      '--write-out',
      '\nPATROL_HTTP_STATUS:%{http_code}',
      input.url
    ];

    for (const header of input.headers ?? []) {
      args.push('--header', header);
    }

    if (input.body) {
      await writeFile(bodyPath, input.body, { encoding: 'utf8', mode: 0o600 });
      args.push('--data-binary', `@${bodyPath}`);
    }

    if (input.digestAuth) {
      await writeFile(
        curlConfigPath,
        `user = "${escapeCurlConfig(input.digestAuth.username)}:${escapeCurlConfig(input.digestAuth.password)}"\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
      args.unshift('--digest', '--config', curlConfigPath);
    }

    const result = await run('curl', args, { capture: true });
    const match = result.stdout.match(/\nPATROL_HTTP_STATUS:(\d{3})$/);
    const status = match ? Number(match[1]) : 0;
    const body = match ? result.stdout.slice(0, match.index) : result.stdout;
    if (input.expectOk !== false && (status < 200 || status >= 300)) {
      throw new Error(`HTTP ${status} from ${input.url}: ${redact(body.trim())}`);
    }
    return { status, body };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  if (dryRun && command !== 'curl') {
    console.log(`dry-run: ${command} ${args.join(' ')}`);
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${exitCode ?? 'null'} signal ${signal ?? 'null'}${stderr ? `: ${redact(stderr.trim())}` : ''}`));
    });
  });
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeCurlConfig(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function redact(value) {
  return value.replaceAll(password, '[password]');
}
