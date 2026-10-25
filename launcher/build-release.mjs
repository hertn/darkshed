// Builds the self-contained download for one system:  node launcher/build-release.mjs <target> [version]
//   targets: mac-arm64, mac-x64, win-x64, linux-x64, linux-arm64
// Needs `npm run build` to have been run (dist/ must exist). Writes release/DarkShed-<version>-<target>.zip (or .tar.gz for Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.12.0';
const TARGETS = {
  'mac-arm64': { node: 'darwin-arm64', ext: 'tar.gz', bin: 'bin/node', os: 'mac' },
  'mac-x64': { node: 'darwin-x64', ext: 'tar.gz', bin: 'bin/node', os: 'mac' },
  'win-x64': { node: 'win-x64', ext: 'zip', bin: 'node.exe', os: 'win' },
  'linux-x64': { node: 'linux-x64', ext: 'tar.xz', bin: 'bin/node', os: 'linux' },
  'linux-arm64': { node: 'linux-arm64', ext: 'tar.xz', bin: 'bin/node', os: 'linux' },
};
const target = process.argv[2];
const t = TARGETS[target];
if (!t) { console.error('Use one of: ' + Object.keys(TARGETS).join(', ')); process.exit(2); }
const version = process.argv[3] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('Run "npm run build" first.'); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshed-build-'));
const name = `DarkShed-${version}-${target}`;
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
for (const f of fs.readdirSync(wr)) { fs.copyFileSync(path.join(wr, f), path.join(dir, f)); fs.chmodSync(path.join(dir, f), f.endsWith('.bat') ? 0o644 : 0o755); }
const S = {
  mac: {
    START_STEPS: '  Double-click  "Start DarkShed.command".',
    FIRST_RUN_NOTE: 'The first time, macOS may say it cannot open the file because it is from an\nunidentified developer (the file is not signed). That is expected. Close the\nmessage, then RIGHT-CLICK (or Control-click) "Start DarkShed.command", choose\nOpen, and choose Open again. You only need to do this once. If macOS still\nblocks it, open System Settings > Privacy & Security, scroll down and click\n"Open Anyway" next to the DarkShed message.',
    BG_STEPS: 'Double-click  "Run in background.command"  (same right-click > Open the first time).',
    STOP_STEPS: 'Double-click  "Stop running in background.command".',
    MANUAL_REMOVE: '  Open Terminal and type:\n    launchctl bootout gui/$(id -u)/com.darkshed.server\n    rm ~/Library/LaunchAgents/com.darkshed.server.plist',
  },
  win: {
    START_STEPS: '  Double-click  "Start DarkShed.bat".',
    FIRST_RUN_NOTE: 'Unzip the whole folder first (do not run it from inside the zip). The first time,\nWindows may show a blue "Windows protected your PC" screen because the file is\nnot signed. That is expected: click "More info", then "Run anyway". To avoid it,\nright-click the downloaded zip > Properties > tick "Unblock" > OK, before unzipping.',
    BG_STEPS: 'Double-click  "Run in background.bat".',
    STOP_STEPS: 'Double-click  "Stop running in background.bat".',
    MANUAL_REMOVE: '  Open Command Prompt and type:\n    schtasks /Delete /TN DarkShed /F',
  },
  linux: {
    START_STEPS: '  Open a terminal in this folder and run:  ./start-darkshed.sh\n  (or double-click it in your file manager and choose "Run").',
    FIRST_RUN_NOTE: 'If it says "Permission denied", run:  chmod +x *.sh runtime/node',
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
