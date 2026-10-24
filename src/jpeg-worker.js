// Worker for jpeg.js: encodes MCU rows handed to it.
import { makeCore } from './jpeg-core.js';

let core = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.init) { core = makeCore(m.W, m.H, m.opts); self.postMessage({ ready: true }); return; }
  const bytes = core.encodeRows(new Uint8Array(m.rgba), m.rows);
  self.postMessage({ id: m.id, bytes }, [bytes.buffer]);
};
