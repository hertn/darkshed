// Optional "run in the background": starts DarkShed when you log in, with no window.
//   node launcher/service.mjs install | remove | status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DARKSHED_DATA || path.join(ROOT, 'data'));
const LABEL = process.env.DARKSHED_SERVICE_LABEL || 'com.darkshed.server';
const NODE = process.execPath;
const START = path.join(ROOT, 'launcher', 'start.mjs');
const plat = process.platform;
const home = os.homedir();
const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unit = path.join(home, '.config', 'systemd', 'user', `${LABEL}.service`);
const TASK = LABEL === 'com.darkshed.server' ? 'DarkShed' : LABEL;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uid = process.getuid?.();

function stopRunning() {                                   // a copy started by hand or by the service
  try { const pid = +fs.readFileSync(path.join(DATA, 'darkshed.pid'), 'utf8'); if (pid) process.kill(pid); } catch { /* not running */ }
}

async function askToken() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nOptional: a sync password. Without one, anyone on your Wi-Fi who opens the address could');
  console.log('see or change your presets (photos are never on the server, so that is all they could reach).');
  const a = (await rl.question('Type a password, or just press Enter to skip: ')).trim();
  rl.close();
  if (!a) return;
  let cfg = {}; const f = path.join(DATA, 'launcher.json');
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* new file */ }
  cfg.token = a; fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  console.log('Saved. Enter the same password under Menu > Sync & settings > Token on each device.');
}

function install() {
  fs.mkdirSync(DATA, { recursive: true });
  const log = path.join(DATA, 'darkshed.log');
  if (plat === 'darwin') {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(LABEL)}</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(START)}</string><string>--no-open</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`);
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    const r = run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (r.status !== 0) { console.error(r.stderr || 'launchctl failed'); process.exit(1); }
  } else if (plat === 'win32') {
    const vbs = path.join(ROOT, 'launcher', 'hidden.vbs');
    const tr = `wscript.exe //B "${vbs}"`;
    const r = run('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/TR', tr, '/RL', 'LIMITED', '/F']);
    if (r.status !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
    run('schtasks', ['/Run', '/TN', TASK]);
  } else {
    if (run('systemctl', ['--user', '--version']).status !== 0) { console.error('systemd was not found, so DarkShed cannot be set up to start in the background on this system.\nStart it by hand with ./start-darkshed.sh instead.'); process.exit(1); }
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=DarkShed\n\n[Service]\nWorkingDirectory=${ROOT}\nExecStart="${NODE}" "${START}" --no-open\nRestart=always\nStandardOutput=append:${log}\nStandardError=append:${log}\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]);
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  }
}

function remove() {
  if (plat === 'darwin') { run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); fs.rmSync(plist, { force: true }); }
  else if (plat === 'win32') { run('schtasks', ['/End', '/TN', TASK]); run('schtasks', ['/Delete', '/TN', TASK, '/F']); }
  else { run('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`]); fs.rmSync(unit, { force: true }); run('systemctl', ['--user', 'daemon-reload']); }
  stopRunning();
}

function status() {
  if (plat === 'darwin') return fs.existsSync(plist);
  if (plat === 'win32') return run('schtasks', ['/Query', '/TN', TASK]).status === 0;
  return fs.existsSync(unit);
}

const cmd = process.argv[2];
if (cmd === 'install') {
  await askToken();
  install();
  console.log('\nDarkShed will now start by itself whenever you log in, with no window.');
  console.log('Give it a few seconds, then open the address below on this computer or your phone:\n');
  await new Promise((r) => setTimeout(r, 2500));
  let shown = false;
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(n.address));
  for (let i = 0; i < 12 && !shown; i++) {                 // the background copy writes the port it really got
    try {
      const port = +fs.readFileSync(path.join(DATA, 'darkshed.port'), 'utf8');
      let tok = ''; try { tok = JSON.parse(fs.readFileSync(path.join(DATA, 'launcher.json'), 'utf8')).token || ''; } catch { /* none */ }
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800), headers: tok ? { authorization: `Bearer ${tok}` } : {} });
      if ((await r.json()).app === 'darkshed') { console.log(`   http://${lan ? lan.address : 'localhost'}:${port}`); shown = true; }
    } catch { /* not ready yet */ }
    if (!shown) await new Promise((r) => setTimeout(r, 700));
  }
  if (!shown) console.log(`   (it did not answer yet; check ${path.join(DATA, 'darkshed.log')})`);
  console.log('\nTo undo this: run "Stop running in background". Then you can delete this folder.');
} else if (cmd === 'remove') {
  remove();
  console.log('DarkShed no longer starts by itself, and the background copy is stopped.');
  console.log('Your presets are still in the data folder. You can delete this folder now if you want.');
} else if (cmd === 'status') {
  console.log(status() ? 'Set up to run in the background.' : 'Not set up to run in the background.');
} else { console.error('Use: install | remove | status'); process.exit(2); }
