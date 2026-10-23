// DarkShed server: serves the built app and stores presets + LUTs. It never sees a photo.
//   DARKSHED_PORT   (default 8080)
//   DARKSHED_DATA   data directory (default ./data)
//   DARKSHED_TOKEN  optional shared secret; clients send "Authorization: Bearer <token>"
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePresets } from '../src/merge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.resolve(process.env.DARKSHED_DATA || path.join(ROOT, 'data'));
const PORT = +process.env.DARKSHED_PORT || 8080;
const TOKEN = process.env.DARKSHED_TOKEN || '';
const MAX_BODY = 12 * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.txt': 'text/plain' };

await fs.mkdir(path.join(DATA, 'luts'), { recursive: true });
const PRESETS = path.join(DATA, 'presets.json');
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const writeJson = async (f, v) => { const t = f + '.tmp'; await fs.writeFile(t, JSON.stringify(v)); await fs.rename(t, f); };
const safeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

const body = (req) => new Promise((res, rej) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { rej(e); } });
  req.on('error', rej);
});
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  const p = url.pathname;
  if (p === '/api/ping') return send(res, 200, { ok: true, auth: !!TOKEN });
  if (p === '/api/presets') {
    if (req.method === 'GET') return send(res, 200, await readJson(PRESETS, {}));
    if (req.method === 'PUT') {
      const merged = mergePresets(await readJson(PRESETS, {}), await body(req));
      await writeJson(PRESETS, merged);
      return send(res, 200, merged);
    }
  }
  if (p === '/api/luts' && req.method === 'GET') {
    const out = [];
    for (const f of await fs.readdir(path.join(DATA, 'luts'))) {
      if (!f.endsWith('.json')) continue;
      const v = await readJson(path.join(DATA, 'luts', f), null);
      if (v) out.push({ id: f.slice(0, -5), name: v.name, size: v.size, updatedAt: v.updatedAt || 0 });
    }
    return send(res, 200, out);
  }
  const m = p.match(/^\/api\/luts\/([^/]+)$/);
  if (m && safeId(m[1])) {
    const f = path.join(DATA, 'luts', m[1] + '.json');
    if (req.method === 'GET') return existsSync(f) ? send(res, 200, await readJson(f, {})) : send(res, 404, { error: 'not found' });
    if (req.method === 'PUT') { const v = await body(req); await writeJson(f, { name: String(v.name || 'LUT'), size: +v.size, data: String(v.data), updatedAt: +v.updatedAt || Date.now() }); return send(res, 200, { ok: true }); }
    if (req.method === 'DELETE') { await fs.rm(f, { force: true }); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || (await fs.stat(file)).isDirectory()) file = path.join(DIST, 'index.html');   // SPA fallback
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : (path.basename(file) === 'sw.js' ? 'no-cache' : 'no-cache'),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`DarkShed on http://localhost:${PORT}  data: ${DATA}${TOKEN ? '  (token required)' : '  (no token set)'}`));
