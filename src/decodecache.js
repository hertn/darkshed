// Keeps the decoded preview of recently opened RAW files in browser storage, so reopening one (switching photos,
// reloading the app) skips the slow RAW decode. Only the half-size preview is kept, not the export decode.
// Limited to the most recent few photos and a total size; the oldest are dropped first.
import { idb } from './store.js';

const VERSION = 1;            // bump when the preview decode changes, so old cached pixels are not reused
const MAX_ITEMS = 12, MAX_BYTES = 400 * 2 ** 20;
const INDEX = 'decodedIndex'; // kv: [{ key, bytes, t }], oldest first

const getIndex = async () => { try { return (await idb.get('kv', INDEX)) || []; } catch { return []; } };
const setIndex = (ix) => idb.set('kv', INDEX, ix).catch(() => {});
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn, fn).catch(() => {}));

/** The cached preview for this photo key, or null. */
export async function getDecoded(key) {
  try {
    const v = await idb.get('decoded', key);
    if (!v || v.v !== VERSION) return null;
    queue(async () => { const ix = await getIndex(); const e = ix.find((x) => x.key === key); if (e) { e.t = Date.now(); ix.sort((a, b) => a.t - b.t); await setIndex(ix); } });
    return { width: v.width, height: v.height, half: new Uint16Array(v.half), fullW: v.fullW, fullH: v.fullH, info: v.info, k: v.k };
  } catch { return null; }
}

/** Store a freshly decoded preview (in the background; failures, e.g. a full disk, are ignored). */
export function putDecoded(key, img) {
  return queue(async () => {
    const bytes = img.half.byteLength;
    if (bytes > MAX_BYTES / 2) return;
    let ix = (await getIndex()).filter((x) => x.key !== key);
    while (ix.length && (ix.length >= MAX_ITEMS || ix.reduce((s, x) => s + x.bytes, 0) + bytes > MAX_BYTES)) {
      await idb.del('decoded', ix.shift().key).catch(() => {});
    }
    try {
      await idb.set('decoded', key, { v: VERSION, width: img.width, height: img.height, half: img.half.buffer.slice(img.half.byteOffset, img.half.byteOffset + bytes), fullW: img.fullW, fullH: img.fullH, info: img.info, k: img.k });
      ix.push({ key, bytes, t: Date.now() });
    } catch {
      // storage full: drop everything cached so the photos themselves keep their room
      for (const x of ix) await idb.del('decoded', x.key).catch(() => {});
      ix = [];
    }
    await setIndex(ix);
  });
}

export const forgetDecoded = (key) => queue(async () => { await idb.del('decoded', key).catch(() => {}); await setIndex((await getIndex()).filter((x) => x.key !== key)); });
export const clearDecoded = () => queue(async () => { for (const x of await getIndex()) await idb.del('decoded', x.key).catch(() => {}); try { for (const k of await idb.keys('decoded')) await idb.del('decoded', k); } catch {} await setIndex([]); });
