// RAW colour table (src/colortable.js): a hue / saturation correction looked up by hue, saturation and brightness in linear
// ProPhoto, applied in the edit shader (dcpApply in src/gl.js) on the as-shot colours. Two tables, tungsten and daylight,
// blended by the photo's as-shot white balance (profileWeight in src/wb.js).
import { COLOR_TABLE } from './colortable.js';

/** The tables as [hue shift, sat scale, 1] per entry (the shader's texture layout). */
const unpack = (t) => { const o = new Float32Array(t.h.length * 3); t.h.forEach((h, i) => { o[i * 3] = h; o[i * 3 + 1] = t.s[i]; o[i * 3 + 2] = 1; }); return o; };
export const COLOR_TABLE_DATA = { dims: COLOR_TABLE.dims, vlog: COLOR_TABLE.vlog, A: unpack(COLOR_TABLE.A), D: unpack(COLOR_TABLE.D) };

const cache = new Map();
/** Table for tungsten weight w (1 = tungsten, 0 = daylight), rounded so photos with similar light share one texture. */
export function blendTable(w) {
  const k = Math.round(Math.min(1, Math.max(0, w)) * 100) / 100;
  let o = cache.get(k);
  if (!o) {
    const { A, D } = COLOR_TABLE_DATA; o = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) o[i] = A[i] * k + D[i] * (1 - k);
    if (cache.size > 16) cache.clear();
    cache.set(k, o);
  }
  return o;
}
