// Keeps the open library on the device so it survives the browser / PWA being reloaded or evicted
// (a message, switching apps, a crash). Originals and thumbnails live in IndexedDB; nothing leaves the device.
import { idb, lsGet, lsSet } from './store.js';
import { app, bus } from './app.js';

// ---- what is kept, for how long, and how much ----
export const keepPrefs = {
  get keep() { return lsGet('keepOn', '1') === '1'; },        set keep(v) { lsSet('keepOn', v ? '1' : '0'); },
  get days() { return +lsGet('keepDays', '7'); },              set days(v) { lsSet('keepDays', String(v)); },       // 0 = never expire
  get capMB() { return +lsGet('keepCapMB', '1024'); },         set capMB(v) { lsSet('keepCapMB', String(v)); },      // 0 = no limit
};
let meta = {}, metaP = null, metaTimer = 0;                    // key -> { t: last used (ms), size }
const loadMeta = () => (metaP ||= idb.get('kv', 'photoMeta').then((m) => { meta = m || {}; }).catch(() => {}));
const saveMeta = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => idb.set('kv', 'photoMeta', meta).catch(() => {}), 1500); };
function touch(key, size) { const m = (meta[key] ||= { t: Date.now(), size: 0 }); m.t = Date.now(); if (size) m.size = size; saveMeta(); }
bus.on('item-used', (it) => { loadMeta().then(() => { if (meta[it.key]) touch(it.key); }); });
export const expiryOf = (key) => { const m = meta[key]; return m && keepPrefs.days ? m.t + keepPrefs.days * 86400000 : null; };

const queue = [];
let running = false;
async function drain() {
  if (running) return; running = true;
  while (queue.length) { const job = queue.shift(); try { await job(); } catch (e) { console.warn('persist', e); } }
  running = false;
}
const enqueue = (job) => { queue.push(job); drain(); };

let askedPersist = false;
export function keepPhoto(item) {
  if (!keepPrefs.keep) return;
  if (!askedPersist) { askedPersist = true; try { navigator.storage?.persist?.(); } catch {} }
  enqueue(async () => {
    await loadMeta();
    if (!(await idb.get('files', item.key))) {
      try { await idb.set('files', item.key, item.file); }
      catch (e) { bus.emit('persist-error', e); return; }
      if (lsGet('keepNoticeShown', '0') !== '1') { lsSet('keepNoticeShown', '1'); bus.emit('keep-notice'); }
    }
    touch(item.key, item.file.size);
    const evicted = await enforceCap(item.key);
    if (evicted.length) bus.emit('persist-evicted', evicted.length);
    await checkSpace();
  });
}

/** Remove the oldest-used stored copies until the total is under the limit. */
async function enforceCap(protect) {
  const cap = keepPrefs.capMB * 1048576;
  if (!cap) return [];
  await loadMeta();
  const keys = await idb.keys('files');
  for (const k of keys) if (!meta[k]?.size) { const f = await idb.get('files', k); meta[k] = { t: meta[k]?.t || Date.now(), size: f?.size || 0 }; }
  let total = keys.reduce((a, k) => a + (meta[k]?.size || 0), 0);
  const order = keys.filter((k) => k !== protect).sort((a, b) => meta[a].t - meta[b].t), removed = [];
  while (total > cap && order.length) { const k = order.shift(); total -= meta[k].size; await idb.del('files', k); await idb.del('thumbs', k); delete meta[k]; removed.push(k); }
  if (removed.length) saveMeta();
  return removed;
}
let warnedSpace = false;
async function checkSpace() {
  try {
    const e = await navigator.storage.estimate();
    if (!e.quota) return;
    const free = e.quota - e.usage;
    if (!warnedSpace && (free < 300 * 1048576 || e.usage / e.quota > 0.9)) { warnedSpace = true; bus.emit('low-space', free); }
  } catch {}
}
/** Delete stored copies that have not been opened or edited for the chosen number of days. Returns how many were removed. */
export async function pruneExpired() {
  await loadMeta();
  const days = keepPrefs.days;
  const keys = await idb.keys('files');
  let n = 0;
  for (const k of keys) {
    if (!meta[k]) { meta[k] = { t: Date.now(), size: 0 }; continue; }
    if (days && meta[k].t < Date.now() - days * 86400000) { await idb.del('files', k); await idb.del('thumbs', k); delete meta[k]; n++; }
  }
  saveMeta();
  return n;
}
export async function applyLimitsNow() { const removed = await enforceCap(app.items[app.cur]?.key); const expired = await pruneExpired(); return removed.length + expired; }
export function keepThumb(item, source) {
  enqueue(async () => {
    const c = document.createElement('canvas');
    const w = source.width, h = source.height, s = Math.min(1, 220 / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
    if (blob) await idb.set('thumbs', item.key, blob);
  });
}
export const forgetPhoto = (key) => enqueue(async () => { await loadMeta(); await idb.del('files', key); await idb.del('thumbs', key); delete meta[key]; saveMeta(); });

let idxTimer = 0;
export function saveIndex() {
  clearTimeout(idxTimer);
  idxTimer = setTimeout(() => {
    const cur = app.items[app.cur];
    idb.set('kv', 'library', { items: app.items.map((i) => ({ key: i.key, name: i.name })), cur: cur ? cur.key : null }).catch(() => {});
  }, 300);
}
export const saveIndexNow = () => { clearTimeout(idxTimer); const cur = app.items[app.cur]; return idb.set('kv', 'library', { items: app.items.map((i) => ({ key: i.key, name: i.name })), cur: cur ? cur.key : null }).catch(() => {}); };

/** { files: [File], thumbs: Map(key -> ImageBitmap), cur } for whatever was open last time. */
export async function readLibrary() {
  const expired = await pruneExpired();
  if (expired) bus.emit('persist-expired', expired);
  let index; try { index = await idb.get('kv', 'library'); } catch (e) { window.__readErr = String(e); return null; }
  window.__readIdx = index ? index.items.length : 'none';
  if (!index?.items?.length) return null;
  const files = [], thumbs = new Map();
  for (const { key } of index.items) {
    try {
      const f = await idb.get('files', key); if (!f) continue;
      files.push(f);
      const t = await idb.get('thumbs', key);
      if (t) try { thumbs.set(key, await createImageBitmap(t)); } catch {}
    } catch {}
  }
  return files.length ? { files, thumbs, cur: index.cur } : null;
}

export async function storageInfo() {
  await loadMeta();
  let count = 0, bytes = 0, oldest = null;
  try {
    for (const k of await idb.keys('files')) {
      count++; const f = await idb.get('files', k); const size = f?.size || meta[k]?.size || 0; bytes += size;
      const exp = expiryOf(k); if (exp && (oldest === null || exp < oldest)) oldest = exp;
    }
  } catch {}
  let quota = 0, usage = 0;
  try { const e = await navigator.storage.estimate(); quota = e.quota || 0; usage = e.usage || 0; } catch {}
  return { count, bytes, quota, usage, nextExpiry: oldest };
}
/** { stored, until } for the Info pane. */
export async function storedStatus(key) {
  await loadMeta();
  try { if (!(await idb.get('files', key))) return { stored: false }; } catch { return { stored: false }; }
  return { stored: true, until: expiryOf(key) };
}
export async function clearStored() {
  for (const k of await idb.keys('files')) await idb.del('files', k);
  for (const k of await idb.keys('thumbs')) await idb.del('thumbs', k);
  await idb.del('kv', 'library'); meta = {}; await idb.del('kv', 'photoMeta');
}
