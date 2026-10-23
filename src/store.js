// Tiny IndexedDB wrapper (edits, LUTs, key/value) with a localStorage fallback for kv.
const DB = 'darkshed', VERSION = 2, STORES = ['edits', 'luts', 'kv', 'files', 'thumbs'];
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
const tx = async (store, mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
};
export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  all: async (store) => {
    const [keys, vals] = await Promise.all([tx(store, 'readonly', (s) => s.getAllKeys()), tx(store, 'readonly', (s) => s.getAll())]);
    return keys.map((k, i) => [k, vals[i]]);
  },
};
export const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
