// Streaming baseline JPEG encoder. Takes RGBA rows top to bottom, so a photo of any size can be saved without a canvas
// (iOS Safari refuses canvases above ~16 MP). Every MCU row is its own restart interval, so rows are encoded in parallel
// on a few worker threads (or on the main thread when workers are not available) and joined in order.
import { makeCore } from './jpeg-core.js';

const WORKERS = Math.max(0, Math.min(5, (navigator.hardwareConcurrency || 2) - 1));

/**
 * const enc = jpegEncoder(width, height, { quality: 1..100, subsample: true });
 * await enc.push(rgbaRows, rowCount) for consecutive bands from the top, then const blob = await enc.finish().
 */
export function jpegEncoder(W, H, opts = {}) {
  const core = makeCore(W, H, opts);
  const { MCU, mcuRows } = core;
  const rowBytes = W * 4;
  let pool = [], failed = false;
  if (WORKERS > 1 && W * H > 2_000_000 && typeof Worker !== 'undefined') {
    try {
      for (let i = 0; i < WORKERS; i++) {
        const w = new Worker(new URL('./jpeg-worker.js', import.meta.url), { type: 'module' });
        w.postMessage({ init: true, W, H, opts });
        w.onerror = () => { failed = true; };
        pool.push(w);
      }
    } catch { for (const w of pool) w.terminate(); pool = []; }
  }

  // a worker that never answers (blocked, unsupported) must not hang the export: wait for every worker to say hello, else encode here
  let started = false, ready = 0, readyRes;
  const readyP = new Promise((r) => { readyRes = r; });
  async function ensurePool() {
    if (started) return; started = true;
    if (!pool.length) return;
    await Promise.race([readyP, new Promise((res) => setTimeout(res, 4000))]);
    if (ready !== pool.length || failed) { for (const w of pool) w.terminate(); pool = []; idle = []; }
  }
  const segments = new Array(mcuRows);      // finished MCU rows (Uint8Array), in order
  const waiting = new Map();                // task id -> { resolve }
  let inflight = 0, idle = [];
  for (const w of pool) {
    idle.push(w);
    w.onmessage = (e) => {
      const { id, bytes } = e.data;
      if (e.data.ready) { if (++ready === pool.length) readyRes(); return; }
      segments[id] = bytes; inflight--; idle.push(w);
      const r = waiting.get(id); if (r) { waiting.delete(id); r(); }
      drain();
    };
  }
  const queue = [];                         // { id, rgba, rows } waiting for a free worker
  let slot = null;                          // resolves the push() that is waiting for room
  function drain() {
    while (queue.length && idle.length) { const t = queue.shift(), w = idle.pop(); inflight++; w.postMessage({ id: t.id, rgba: t.rgba.buffer, rows: t.rows }, [t.rgba.buffer]); }
    if (slot && queue.length < pool.length) { const s = slot; slot = null; s(); }
    if (allDone && inflight === 0 && !queue.length) allDone();
  }
  let allDone = null;

  const pending = new Uint8Array(rowBytes * MCU);
  let have = 0, doneRows = 0, mcuRow = 0;

  async function flushRow(rows) {
    const id = mcuRow++;
    if (!pool.length || failed) { segments[id] = core.encodeRows(pending, rows); await new Promise((r) => setTimeout(r, 0)); return; }
    queue.push({ id, rgba: pending.slice(0, rowBytes * rows), rows });
    drain();
    if (queue.length >= pool.length) await new Promise((r) => { slot = r; });     // keep memory bounded: wait until the workers catch up
  }

  return {
    async push(rgba, n) {
      await ensurePool();
      for (let r = 0; r < n; r++) {
        pending.set(rgba.subarray(r * rowBytes, (r + 1) * rowBytes), have * rowBytes);
        have++; doneRows++;
        if (have === MCU) { have = 0; await flushRow(MCU); }
      }
    },
    async finish() {
      await ensurePool();
      if (have) await flushRow(have);
      if (doneRows !== H || mcuRow !== mcuRows) throw new Error(`JPEG encoder got ${doneRows} of ${H} rows`);
      if (pool.length && (queue.length || inflight)) await new Promise((r) => { allDone = r; drain(); });
      for (const w of pool) w.terminate();
      if (failed) throw new Error('JPEG worker failed');
      const parts = [core.head];
      for (let i = 0; i < mcuRows; i++) {
        parts.push(segments[i]);
        if (i < mcuRows - 1) parts.push(Uint8Array.of(0xff, 0xd0 + (i & 7)));
      }
      parts.push(Uint8Array.of(0xff, 0xd9));
      return new Blob(parts, { type: 'image/jpeg' });
    },
  };
}
