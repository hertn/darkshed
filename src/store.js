// Tiny IndexedDB wrapper (edits, LUTs, key/value).
const DB = 'darkshed', VERSION = 3, STORES = ['edits', 'luts', 'kv', 'files', 'thumbs', 'decoded'];
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => {
        // another tab upgrading the database must not be blocked by this one; the next call opens it again
        r.result.onversionchange = () => { r.result.close(); dbp = null; };
        res(r.result);
      };
      r.onblocked = () => console.warn('The photo database is open in another tab; close it to finish updating');
      r.onerror = () => rej(r.error);
    }).catch((e) => { dbp = null; throw e; });   // a failed open is retried next time, not remembered
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
  // keys and values in one transaction, so a write in between cannot shift them out of step
  all: async (store) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, 'readonly'), out = [];
      t.objectStore(store).openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push([c.key, c.value]); c.continue(); } };
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
};
export const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
