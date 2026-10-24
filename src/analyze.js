// Image analysis on the decoded proxy (RGBA half-float, linear): white balance picking, auto tone.
import { TUNE } from './tuning.js';
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function h2f(h) {
  const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return (s ? -1 : 1) * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  u32[0] = s | ((e + 112) << 23) | (m << 13);
  return f32[0];
}
const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const dec = (s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

/** Mean linear RGB in a square of the given radius around (u, v) in 0..1 image coordinates. */
export function samplePatch(img, u, v, radius = 3) {
  const { width: w, height: h, half } = img;
  const cx = Math.round(u * (w - 1)), cy = Math.round(v * (h - 1));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const i = (y * w + x) * 4;
      r += h2f(half[i]); g += h2f(half[i + 1]); b += h2f(half[i + 2]); n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0.18, 0.18, 0.18];
}

/** The white balance matrix the shader builds for temperature / tint sliders in -1..1 (see wbMat in gl.js). */
export function wbMatrix(temp, tint) {
  const scaled = (K, t) => {
    const d = [K[0], K[4], K[8]];
    return K.map((v, i) => (i % 4 === 0 ? Math.pow(d[i / 4], t) : v * t));
  };
  const mul = (A, B) => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
  };
  return mul(scaled(TUNE.wbKt, temp * 4), scaled(TUNE.wbKn, tint * 5));
}

/** Temp / tint (-100..100) that make a linear RGB value neutral under the shader's white balance model. */
export function wbFromLinear([r, g, b], precise = false) {
  r = Math.max(r, 1e-4); g = Math.max(g, 1e-4); b = Math.max(b, 1e-4);
  const err = (t, n) => {
    const m = wbMatrix(t, n);
    const o = [0, 1, 2].map((i) => Math.max(m[i * 3] * r + m[i * 3 + 1] * g + m[i * 3 + 2] * b, 1e-6));
    return [Math.log(o[0] / o[1]), Math.log(o[2] / o[1])];
  };
  let t = 0, n = 0;
  for (let it = 0; it < 30; it++) {                       // Newton steps with a numerical Jacobian
    const e = err(t, n), h = 1e-3;
    const a = err(t + h, n), c = err(t, n + h);
    const j00 = (a[0] - e[0]) / h, j10 = (a[1] - e[1]) / h, j01 = (c[0] - e[0]) / h, j11 = (c[1] - e[1]) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) break;
    t = Math.max(-1, Math.min(1, t - (e[0] * j11 - e[1] * j01) / det));
    n = Math.max(-1, Math.min(1, n - (j00 * e[1] - j10 * e[0]) / det));
  }
  const clamp = (x) => Math.max(-100, Math.min(100, precise ? x * 100 : Math.round(x * 100)));
  return { temp: clamp(t), tint: clamp(n) };
}

function subsample(img, maxSamples = 60000) {
  const { width: w, height: h, half } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / maxSamples)));
  const out = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    out.push([h2f(half[i]), h2f(half[i + 1]), h2f(half[i + 2])]);
  }
  return out;
}
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Grey-world style auto white balance on mid-tone, low-saturation-ish pixels. */
export function autoWb(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of subsample(img)) {
    const l = luma(p);
    if (l < 0.04 || l > 0.7) continue;
    const mx = Math.max(...p), mn = Math.min(...p);
    if (mx > 0 && (mx - mn) / mx > 0.6) continue;     // skip strongly coloured pixels
    r += p[0]; g += p[1]; b += p[2]; n++;
  }
  if (!n) return { temp: 0, tint: 0 };
  return wbFromLinear([r / n, g / n, b / n]);
}

/**
 * Automatic tone. Conservative on purpose: a well-exposed photo is left alone, an under-exposed one is lifted, an over-exposed one is
 * pulled down a little, and highlights / shadows / blacks are only touched when clipping or crushing is actually measured.
 */
export function autoTone(img) {
  const ls = subsample(img).map(luma).sort((a, b) => a - b);
  const n = ls.length, at = (q) => ls[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
  const enc2 = (v) => enc(Math.min(1, Math.max(0, v)));
  const median = enc2(at(0.5));
  // exposure: distance (in stops) of the median from a pleasant mid value, with a dead zone so normal exposures stay put
  const e0 = Math.log2(dec(0.46) / Math.max(dec(median), 1e-4));
  const shrink = Math.sign(e0) * Math.max(0, Math.abs(e0) - 0.4) * (e0 > 0 ? 0.78 : 0.62);
  const stops = Math.max(-1.2, Math.min(2.2, shrink));
  const exposure = Math.round((stops / TUNE.exK) * 100) / 100;      // the slider is Lightroom-scaled: one unit is exK stops here
  const gain = Math.pow(2, exposure * TUNE.exK);
  const g = (q) => enc2(at(q) * gain);
  const frac = (pred) => { let c = 0; for (let i = 0; i < n; i++) if (pred(enc2(ls[i] * gain))) c++; return c / n; };
  const clipped = frac((v) => v >= 0.985), dark = frac((v) => v < 0.14);
  const p995 = g(0.995), p005 = g(0.005), p02 = g(0.02), p98 = g(0.98);
  const hasWhites = enc2(at(0.995)) >= 0.9;                                                // the photo already reaches real white
  const c = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  const span = p98 - p02;
  return {
    exposure,
    highlights: clipped > 0.004 ? c(-(clipped * 1700 + 6), -60, -6) : 0,                  // only when something is really blown
    whites: !hasWhites && p995 < 0.9 ? c((0.95 - p995) * 220, 0, 25) : 0,                  // open the top end only if the photo never reaches white
    blacks: p005 > 0.06 ? c(-(p005 - 0.03) * 380, -40, 0) : 0,                              // only when blacks are lifted / hazy
    shadows: dark > 0.3 && exposure < 0.9 ? c((dark - 0.22) * 110, 0, 45) : 0,              // only when a large part is very dark
    contrast: span < 0.58 ? c((0.68 - span) * 55, 0, 14) : 0,                                // only flat images get contrast
  };
}
