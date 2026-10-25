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

// the address a phone on the same Wi-Fi can use: first private IPv4 of this computer
const lan = Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(n.address))
  .map((n) => n.address)[0];
const hasV6 = !!Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv6');
// a port counts as free only if nothing answers on it (another app may listen on just some addresses, and the
// browser would then show that app instead of DarkShed) and we can claim it on every address
const answers = (host, port) => new Promise((res) => {
  const c = net.connect({ host, port });
  c.setTimeout(500);
  c.once('connect', () => { c.destroy(); res(true); });
  c.once('timeout', () => { c.destroy(); res(false); });
  c.once('error', () => res(false));
});
const bindable = (host, port) => new Promise((res) => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen({ port, host, exclusive: true });
});
const free = async (port) => {
  for (const h of ['127.0.0.1', '::1', ...(lan ? [lan] : [])]) if (await answers(h, port)) return false;
  return (await bindable('0.0.0.0', port)) && (await bindable('::', port).then((ok) => ok || !hasV6));
};
const want = +process.env.DARKSHED_PORT || +cfg.port || 8080;
let port = want;
while (!(await free(port)) && port < want + 20) port++;
if (!(await free(port))) { console.error(`No free port found near ${want}.`); process.exit(1); }

const host = lan || 'localhost';
const url = `http://${host}:${port}`;

process.env.DARKSHED_PORT = String(port);
process.env.DARKSHED_DATA = DATA;
if (cfg.token) process.env.DARKSHED_TOKEN = String(cfg.token);

const pidFile = path.join(DATA, 'darkshed.pid');
fs.writeFileSync(pidFile, String(process.pid));
const portFile = path.join(DATA, 'darkshed.port');
fs.writeFileSync(portFile, String(port));
const bye = () => { for (const f of [pidFile, portFile]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } process.exit(0); };
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

// make sure the address really leads to this DarkShed and not to some other program
for (const h of new Set(['127.0.0.1', host])) {
  const ok = await fetch(`http://${h}:${port}/api/ping`, { signal: AbortSignal.timeout(2000), headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {} })
    .then((r) => r.json()).then((j) => j.app === 'darkshed').catch(() => false);
  if (!ok) console.log(`\n  WARNING: ${h}:${port} did not answer like DarkShed. Another program may be using that port.\n  Set a different port in data/launcher.json, for example {"port": 8090}, and start again.`);
}

if (!noOpen) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch { /* the address above works by hand */ }
}
