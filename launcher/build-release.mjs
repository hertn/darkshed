// Builds the self-contained download for one system:  node launcher/build-release.mjs <target> [version]
//   targets: mac-arm64, mac-x64, win-x64, linux-x64, linux-arm64 (the files are named mac-apple-silicon, mac-intel, windows, linux-intel-amd, linux-arm)
// Needs `npm run build` to have been run (dist/ must exist). Writes release/DarkShed-<version>-<target>.zip (or .tar.gz for Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.12.0';
const TARGETS = {
  'mac-arm64': { node: 'darwin-arm64', ext: 'tar.gz', bin: 'bin/node', os: 'mac', label: 'mac-apple-silicon' },
  'mac-x64': { node: 'darwin-x64', ext: 'tar.gz', bin: 'bin/node', os: 'mac', label: 'mac-intel' },
  'win-x64': { node: 'win-x64', ext: 'zip', bin: 'node.exe', os: 'win', label: 'windows' },
  'linux-x64': { node: 'linux-x64', ext: 'tar.xz', bin: 'bin/node', os: 'linux', label: 'linux-intel-amd' },
  'linux-arm64': { node: 'linux-arm64', ext: 'tar.xz', bin: 'bin/node', os: 'linux', label: 'linux-arm' },
};
const target = process.argv[2];
const t = TARGETS[target];
if (!t) { console.error('Use one of: ' + Object.keys(TARGETS).join(', ')); process.exit(2); }
const version = process.argv[3] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('Run "npm run build" first.'); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshed-build-'));
const name = `DarkShed-${version}-${t.label}`;
const dir = path.join(work, 'DarkShed');
fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });

// 1. Node.js itself (official build, checked against nodejs.org's published checksums)
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const archive = `node-v${NODE_VERSION}-${t.node}.${t.ext}`;
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
const sums = (await get(`${base}/SHASUMS256.txt`)).toString();
const want = sums.split('\n').find((l) => l.endsWith('  ' + archive))?.split(/\s+/)[0];
const cache = process.env.NODE_CACHE ? path.resolve(process.env.NODE_CACHE) : null;
let buf;
if (cache && fs.existsSync(path.join(cache, archive))) buf = fs.readFileSync(path.join(cache, archive));
else { buf = await get(`${base}/${archive}`); if (cache) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, archive), buf); } }
const { createHash } = await import('node:crypto');
if (!want || createHash('sha256').update(buf).digest('hex') !== want) throw new Error('Node download does not match its checksum');
const arch = path.join(work, archive); fs.writeFileSync(arch, buf);
const ex = path.join(work, 'node-x'); fs.mkdirSync(ex);
if (t.ext === 'zip') execFileSync('unzip', ['-q', arch, '-d', ex]); else execFileSync('tar', ['-xf', arch, '-C', ex]);
const nodeDir = path.join(ex, `node-v${NODE_VERSION}-${t.node}`);
fs.copyFileSync(path.join(nodeDir, t.bin), path.join(dir, 'runtime', path.basename(t.bin)));
fs.chmodSync(path.join(dir, 'runtime', path.basename(t.bin)), 0o755);
fs.copyFileSync(path.join(nodeDir, 'LICENSE'), path.join(dir, 'runtime', 'NODE-LICENSE.txt'));

// 2. the app: built files, server, and the one source file the server shares with the app
fs.cpSync(path.join(ROOT, 'dist'), path.join(dir, 'dist'), { recursive: true });
fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src')); fs.copyFileSync(path.join(ROOT, 'src', 'merge.js'), path.join(dir, 'src', 'merge.js'));
fs.mkdirSync(path.join(dir, 'launcher'));
for (const f of ['start.mjs', 'service.mjs', 'hidden.vbs']) fs.copyFileSync(path.join(ROOT, 'launcher', f), path.join(dir, 'launcher', f));
fs.mkdirSync(path.join(dir, 'data'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE.txt'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');

// 3. the double-click files and the instructions for this system
const wr = path.join(ROOT, 'launcher', 'wrappers', t.os);
for (const f of fs.readdirSync(wr)) {
  const text = fs.readFileSync(path.join(wr, f), 'utf8').replace(/\r?\n/g, f.endsWith('.bat') ? '\r\n' : '\n');   // .bat files need Windows line endings
  fs.writeFileSync(path.join(dir, f), text); fs.chmodSync(path.join(dir, f), f.endsWith('.bat') ? 0o644 : 0o755);
}
const S = {
  mac: {
    UNPACK_STEPS: 'Your Mac unzips the download for you (double-click the zip if it did not).\nThe result is a folder called DarkShed.',
    START_STEPS: '  Double-click  "Start DarkShed.command"  inside the DarkShed folder.',
    FIRST_RUN_NOTE: 'The first time, macOS will refuse to open it, because the file is from an\nindependent developer and is not signed. This is expected. Do this once:\n\n  Newer macOS (Sequoia, macOS 15 or later):\n    1. Double-click the file. A message says it could not be verified.\n       Click Done.\n    2. Open the Apple menu > System Settings > Privacy & Security.\n    3. Scroll down to the message about "Start DarkShed.command" and click\n       "Open Anyway". Enter your Mac password, then click Open.\n\n  Older macOS:\n    Right-click (or Control-click) the file, choose Open, then Open again.\n\nThe same one-time step applies to "Run in background.command" if you use it.',
    FIREWALL_NOTE: 'The first time, your Mac asks: Do you want the application "node" to accept\nincoming network connections? ("node" is the engine DarkShed uses.) Click\nAllow, or your phone cannot reach DarkShed.',
    BG_STEPS: 'Double-click  "Run in background.command"  (the same one-time Open Anyway step applies).',
    STOP_STEPS: 'Double-click  "Stop running in background.command".',
    MANUAL_REMOVE: '  Open Terminal and type:\n    launchctl bootout gui/$(id -u)/com.darkshed.server\n    rm ~/Library/LaunchAgents/com.darkshed.server.plist',
  },
  win: {
    UNPACK_STEPS: 'Do NOT run DarkShed from inside the zip. Right-click the downloaded zip file,\nchoose "Extract All...", then click Extract. A folder called DarkShed appears.\nOpen that folder.',
    START_STEPS: '  Double-click  "Start DarkShed"  (its type says Windows Batch File).',
    FIRST_RUN_NOTE: 'The first time, Windows may show a blue "Windows protected your PC" screen,\nbecause the file is not signed. This is expected: click "More info", then\n"Run anyway". To avoid it, right-click the downloaded zip > Properties > tick\n"Unblock" > OK, before extracting.',
    FIREWALL_NOTE: 'The first time, Windows shows a "Windows Security Alert" about "Node.js\nJavaScript Runtime" (the engine DarkShed uses). Tick "Private networks" and\nclick "Allow access", or your phone cannot reach DarkShed.',
    BG_STEPS: 'Double-click  "Run in background".',
    STOP_STEPS: 'Double-click  "Stop running in background".',
    MANUAL_REMOVE: '  Open Command Prompt and type:\n    schtasks /Delete /TN DarkShed /F',
  },
  linux: {
    UNPACK_STEPS: 'Unpack the download (right-click > Extract, or: tar -xzf <file>).\nThe result is a folder called DarkShed.',
    START_STEPS: '  Open a terminal in the DarkShed folder and run:  ./start-darkshed.sh\n  (or double-click it in your file manager and choose "Run").',
    FIRST_RUN_NOTE: 'If it says "Permission denied", run:  chmod +x *.sh runtime/node',
    FIREWALL_NOTE: 'If your phone cannot connect, your firewall may be blocking the port shown in\nthe window (8080 unless it says otherwise). Allow it for your home network.',
    BG_STEPS: 'Run  ./run-in-background.sh   (needs systemd, which most desktop Linux has).',
    STOP_STEPS: 'Run  ./stop-running-in-background.sh',
    MANUAL_REMOVE: '  systemctl --user disable --now com.darkshed.server.service\n  rm ~/.config/systemd/user/com.darkshed.server.service',
  },
}[t.os];
let txt = fs.readFileSync(path.join(ROOT, 'launcher', 'READ-ME-FIRST.template.txt'), 'utf8');
for (const [k, v] of Object.entries(S)) txt = txt.replace(`{{${k}}}`, v);
fs.writeFileSync(path.join(dir, 'READ ME FIRST.txt'), t.os === 'win' ? txt.replace(/\n/g, '\r\n') : txt);

// 4. pack (zip keeps the file permissions; Linux uses tar.gz so the executable bits survive everywhere)
const out = path.join(ROOT, 'release'); fs.mkdirSync(out, { recursive: true });
let file;
if (t.os === 'linux') { file = path.join(out, `${name}.tar.gz`); execFileSync('tar', ['-czf', file, '-C', work, 'DarkShed']); }
else { file = path.join(out, `${name}.zip`); fs.rmSync(file, { force: true }); execFileSync('zip', ['-qrX', file, 'DarkShed'], { cwd: work }); }
fs.rmSync(work, { recursive: true, force: true });
console.log(`${file}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
