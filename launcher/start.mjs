// DarkShed launcher: starts the server from the downloaded folder and opens the browser.
//   --no-open   do not open the browser (used when it runs in the background)
// Settings live in data/launcher.json: { "port": 8080, "token": "optional sync password" }
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DARKSHED_DATA || path.join(ROOT, 'data'));
const noOpen = process.argv.includes('--no-open');
fs.mkdirSync(DATA, { recursive: true });

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'launcher.json'), 'utf8')); } catch { /* none yet */ }

const free = (port) => new Promise((res) => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(port);
});
const want = +process.env.DARKSHED_PORT || +cfg.port || 8080;
let port = want;
while (!(await free(port)) && port < want + 20) port++;
if (!(await free(port))) { console.error(`No free port found near ${want}.`); process.exit(1); }

// the address a phone on the same Wi-Fi can use: first private IPv4 of this computer
const lan = Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(n.address))
  .map((n) => n.address)[0];
const host = lan || 'localhost';
const url = `http://${host}:${port}`;

process.env.DARKSHED_PORT = String(port);
process.env.DARKSHED_DATA = DATA;
if (cfg.token) process.env.DARKSHED_TOKEN = String(cfg.token);

const pidFile = path.join(DATA, 'darkshed.pid');
fs.writeFileSync(pidFile, String(process.pid));
const bye = () => { try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ } process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('SIGHUP', bye);

await import(pathToFileURL(path.join(ROOT, 'server', 'index.mjs')).href);

const line = '-'.repeat(62);
console.log(`\n${line}\n  DarkShed is running.\n\n  On this computer:   ${url}`);
if (lan) {
  console.log(`  On your phone:      ${url}   (same Wi-Fi)`);
  const mdns = os.hostname().replace(/\.local$/i, '');
  if (mdns && /^[A-Za-z0-9-]+$/.test(mdns)) console.log(`  or, if that works:  http://${mdns}.local:${port}`);
} else console.log('  No Wi-Fi / network address found, so only this computer can use it.');
if (cfg.token) console.log('  A sync password is set: enter it under Menu > Sync & settings > Token on each device.');
if (port !== want) console.log(`\n  (Port ${want} was busy, so ${port} is used instead.)`);
console.log(`\n  Presets and LUTs are stored in: ${DATA}\n  Close this window (or press Ctrl+C) to stop DarkShed.\n${line}\n`);

if (!noOpen) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch { /* the address above works by hand */ }
}
