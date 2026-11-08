// Optional sync of presets + LUTs with the DarkShed server. Photos are never uploaded.
import { bus } from './app.js';
import { mergePresets } from './merge.js';
import { userPresets, mergeUserPresets, listLuts, allLutData, saveLut, deleteLut } from './looks.js';
import { idb, lsGet, lsSet } from './store.js';
import { toast } from './ui/overlays.js';
import { MAX_LUT_SIZE } from './lut.js';

export const sync = { enabled: false, status: 'Not connected', last: 0 };
const cfg = () => ({ url: (lsGet('syncUrl', '') || '').replace(/\/$/, ''), token: lsGet('syncToken', '') });
const hdr = () => { const { token } = cfg(); return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }; };
const api = (path, init = {}) => fetch(cfg().url + path, { ...init, headers: { ...hdr(), ...(init.headers || {}) } });

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** JSON from the server, or an error if it did not answer 200 (an error body must never be treated as data). */
const getJson = async (path) => { const r = await api(path); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); };
/** Same rules as the server's: RGBA8 3D data, so the byte count follows from the size. */
const lutOk = (v) => !!v && Number.isInteger(v.size) && v.size >= 2 && v.size <= MAX_LUT_SIZE && typeof v.data === 'string' && v.data.length === 4 * Math.ceil((v.size ** 3 * 4) / 3);

export async function ping() {
  try {
    const r = await api('/api/ping');
    if (r.status === 401) return { ok: false, msg: 'Wrong or missing token' };
    if (!r.ok) return { ok: false, msg: `Server answered ${r.status}` };
    const j = await r.json().catch(() => null);
    return j && j.ok ? { ok: true, auth: j.auth } : { ok: false, msg: 'This address is not a DarkShed server' };
  } catch { return { ok: false, msg: 'Could not reach the server' }; }
}

let busy = false;
export async function syncNow(quiet = true) {
  if (busy) return; busy = true;
  try {
    const p = await ping();
    if (!p.ok) { sync.enabled = false; sync.status = p.msg; if (!quiet) toast(p.msg); return; }
    sync.enabled = true;
    // presets: pull, merge, push the merge back
    const remote = await getJson('/api/presets');
    const merged = mergePresets(userPresets(), remote);
    await mergeUserPresets(merged);
    const put = await api('/api/presets', { method: 'PUT', body: JSON.stringify(merged) });
    if (!put.ok) throw new Error(`presets upload: ${put.status}`);
    // LUTs: fetch the ones we lack, upload the ones the server lacks
    const rl = await getJson('/api/luts');
    if (!Array.isArray(rl)) throw new Error('LUT list is not a list');
    const local = await listLuts();
    const have = new Set(local.map((l) => l.id)), there = new Set(rl.map((l) => l.id));
    for (const l of rl) if (!have.has(l.id)) {
      const v = await getJson(`/api/luts/${l.id}`);
      if (!lutOk(v)) { console.warn('ignored a LUT from the server that is not valid', l.id); continue; }
      await idb.set('luts', l.id, { name: v.name, size: v.size, data: unb64(v.data), updatedAt: v.updatedAt });
    }
    for (const [id, v] of await allLutData()) if (!there.has(id)) {
      await api(`/api/luts/${id}`, { method: 'PUT', body: JSON.stringify({ name: v.name, size: v.size, data: b64(v.data), updatedAt: v.updatedAt || Date.now() }) });
    }
    bus.emit('luts');
    sync.last = Date.now(); sync.status = 'Synced';
    if (!quiet) toast('Presets synced');
  } catch (e) { console.warn('sync failed', e); sync.status = 'Sync failed'; if (!quiet) toast('Sync failed'); }
  finally { busy = false; bus.emit('sync-status'); }
}
export async function removeLutEverywhere(id) {
  await deleteLut(id);
  if (sync.enabled) { try { await api(`/api/luts/${id}`, { method: 'DELETE' }); } catch {} }
}

let timer = 0;
const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (sync.enabled) syncNow(true); }, 1500); };
bus.on('presets-changed-local', later);
bus.on('luts', () => { if (!busy) later(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && sync.enabled) syncNow(true); });
// the app is normally served by the same server, so try that first
setTimeout(() => syncNow(true), 600);
export { lsGet, lsSet };
