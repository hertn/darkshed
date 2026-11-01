// Tone map mask, the way Lightroom's Highlights / Shadows work: their strength is decided by the brightness of the *region* a
// pixel sits in, not by the pixel itself, and applied as a gain. A dark detail in a bright sky keeps its contrast instead of
// being flattened by a global curve, and a lit face in a dark scene gets the scene's shadow lift.
// Here: a small edge-aware map of log2 brightness (box-averaged cells, then a bilateral filter so big brightness jumps stay
// separate). The shader upsamples it with the pixel's own brightness as the guide (joint bilateral upsampling).
import { TUNE } from './tuning.js';

const HALF = (() => {   // half-float bits -> float
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

/** Grid size for an image of W x H (cells on the long edge from TUNE.tmGrid). */
export function maskSize(W, H) {
  const g = TUNE.tmGrid;
  return W >= H ? [g, Math.max(2, Math.round((g * H) / W))] : [Math.max(2, Math.round((g * W) / H)), g];
}

/** Build the mask from a luminance reader. lumAt(x, y) returns linear luminance; it is sampled on a step grid. */
function build(W, H, lumAt) {
  const [gw, gh] = maskSize(W, H);
  const sum = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
  const step = Math.max(1, Math.floor(Math.min(W / gw, H / gh) / 6));   // ~36 samples per cell is plenty for an average
  for (let y = 0; y < H; y += step) {
    const gy = Math.min(gh - 1, ((y * gh) / H) | 0);
    for (let x = 0; x < W; x += step) {
      const v = lumAt(x, y);
      if (!(v >= 0)) continue;
      const k = gy * gw + Math.min(gw - 1, ((x * gw) / W) | 0);
      sum[k] += v; cnt[k]++;
    }
  }
  let L = new Float32Array(gw * gh);
  for (let k = 0; k < L.length; k++) L[k] = Math.log2(Math.max(cnt[k] ? sum[k] / cnt[k] : 0, 2 ** -14));
  // bilateral on the grid: spatial sigma in cells, range sigma in stops
  const ss = TUNE.tmSigS, sr = TUNE.tmSigR, R = Math.ceil(ss * 2);
  for (let it = 0; it < TUNE.tmIter; it++) {
    const out = new Float32Array(L.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const c = L[y * gw + x]; let acc = 0, ws = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= gh) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= gw) continue;
          const v = L[yy * gw + xx], d = v - c;
          const w = Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss) - (d * d) / (2 * sr * sr));
          acc += v * w; ws += w;
        }
      }
      out[y * gw + x] = acc / ws;
    }
    L = out;
  }
  return { w: gw, h: gh, data: L };
}

const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** From the proxy's RGBA16F bits (linear). */
export function maskFromHalf(W, H, half) {
  return build(W, H, (x, y) => { const i = (y * W + x) * 4; return lumOf(HALF[half[i]], HALF[half[i + 1]], HALF[half[i + 2]]); });
}

/** From a full-size RAW decode: 16-bit samples (ch per pixel) and the 16-bit -> linear half-float lookup (decode.js lutLinear16). */
export function maskFromRgb16(W, H, rgb16, ch, lutHalf) {
  return build(W, H, (x, y) => { const i = (y * W + x) * ch; return lumOf(HALF[lutHalf[rgb16[i]]], HALF[lutHalf[rgb16[i + 1]]], HALF[lutHalf[rgb16[i + 2]]]); });
}

/** From an image bitmap (JPEG etc.): drawn small, then sRGB-decoded. */
export function maskFromBitmap(bitmap) {
  const W = bitmap.width, H = bitmap.height, [gw, gh] = maskSize(W, H);
  const sw = gw * 6, sh = gh * 6;
  const c = new OffscreenCanvas(sw, sh), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const T = new Float32Array(256).map((_, i) => lin(i));
  return build(sw, sh, (x, y) => { const i = (y * sw + x) * 4; return lumOf(T[d[i]], T[d[i + 1]], T[d[i + 2]]); });
}
