// White balance for RAW files in Kelvin, computed from the camera's own colour data: what a white surface looks like under an
// illuminant of colour temperature K, as rendered with the as-shot white balance.
import { wbFromLinear } from './analyze.js';

/** CIE xy of a daylight / blackbody illuminant at temperature K. */
function xyOf(K) {
  K = Math.max(1700, Math.min(25000, K));
  let x, y;
  if (K >= 4000) {
    const t = K;
    x = K <= 7000 ? -4.607e9 / t ** 3 + 2.9678e6 / t ** 2 + 0.09911e3 / t + 0.244063 : -2.0064e9 / t ** 3 + 1.9018e6 / t ** 2 + 0.24748e3 / t + 0.23704;
    y = -3 * x * x + 2.87 * x - 0.275;
  } else {
    x = -0.2661239e9 / K ** 3 - 0.2343589e6 / K ** 2 + 0.8776956e3 / K + 0.17991;
    y = K < 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  }
  return [x, y];
}
const xyz = (K) => { const [x, y] = xyOf(K); return [x / y, 1, (1 - x - y) / y]; };
const mulv = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

/** Linear sRGB colour of a white surface under illuminant K, as rendered with the as-shot white balance. */
function whiteUnderAsShot(wb, K) {
  const raw = mulv(wb.camXyz, xyz(K));                       // camera raw response
  const m = wb.camMul.map((v) => v / wb.camMul[1]);          // as-shot multipliers (green = 1)
  return mulv(wb.rgbCam, raw.map((v, i) => v * m[i]));
}

/** The colour temperature the camera's as-shot white balance corresponds to (nearest 50 K): the illuminant a white surface would have
 *  to have for the as-shot multipliers to make it neutral. */
export function asShotKelvin(wb) {
  if (wb._k0) return wb._k0;
  let best = 5500, bestE = Infinity;
  for (let K = 2000; K <= 12000; K += 50) {
    const [r, g, b] = whiteUnderAsShot(wb, K);
    if (r <= 0 || g <= 0 || b <= 0) continue;
    const e = Math.abs(Math.log(r / g)) + Math.abs(Math.log(b / g));
    if (e < bestE) { bestE = e; best = K; }
  }
  return (wb._k0 = Math.round(best / 50) * 50);
}

/** Per-channel gains (linear sRGB, applied to the as-shot picture) that make it look as if the light had been K instead of the
 *  as-shot colour temperature. K = as shot gives 1, 1, 1. A higher K gives a warmer picture. */
export function kelvinGains(wb, K) {
  const w0 = whiteUnderAsShot(wb, asShotKelvin(wb)), w = whiteUnderAsShot(wb, Math.max(1700, Math.min(50000, K)));
  const g = w0.map((v, i) => (v > 0 && w[i] > 0 ? v / w[i] : 1));
  return g.map((v) => v / g[1]);
}

/** Best { wbK, tint } for a picture patch (linear sRGB, as shot) that should come out neutral. */
export function kelvinFromNeutral(wb, [r, g, b]) {
  r = Math.max(r, 1e-4); g = Math.max(g, 1e-4); b = Math.max(b, 1e-4);
  let best = asShotKelvin(wb), bestE = Infinity;
  for (let K = 2000; K <= 50000; K += 50) {
    const k = kelvinGains(wb, K), x = r * k[0], y = g * k[1], z = b * k[2];
    const e = Math.abs(Math.log(x / y)) + Math.abs(Math.log(z / y));
    if (e < bestE) { bestE = e; best = K; }
  }
  const k = kelvinGains(wb, best);
  const tint = wbFromLinear([r * k[0], g * k[1], b * k[2]]).tint;
  return { wbK: best === asShotKelvin(wb) ? 0 : best, temp: 0, tint };
}

// The slider is not linear in Kelvin: 2000 K to 50000 K, with the middle of the track near 7000 K, so the warm end where most
// photos live gets the room. POS_MAX positions keep every 50 K step reachable.
export const POS_MAX = 4000;
const K_LO = 2000, K_HI = 50000, K_CURVE = 3.26;
export const posToKelvin = (pos) => Math.round((K_LO + (K_HI - K_LO) * Math.pow(Math.max(0, Math.min(1, pos / POS_MAX)), K_CURVE)) / 50) * 50;
export const kelvinToPos = (K) => POS_MAX * Math.pow(Math.max(0, Math.min(1, (K - K_LO) / (K_HI - K_LO))), 1 / K_CURVE);

// Older edits stored RAW white balance as a -100..100 temp. This reads such a value as a Kelvin for display.
function kTable(wb) {
  if (wb._kt) return wb._kt;
  const ks = [], ts = [];
  for (let K = 2000; K <= 25000; K += 50) { ks.push(K); ts.push(wbFromLinear(whiteUnderAsShot(wb, K), true).temp); }
  for (let i = 1; i < ts.length; i++) ts[i] = Math.max(ts[i], ts[i - 1]);
  return (wb._kt = { ks, ts });
}
export function tempToKelvin(wb, temp) {
  if (!temp) return asShotKelvin(wb);
  const { ks, ts } = kTable(wb);
  if (temp <= ts[0]) return ks[0];
  for (let i = 1; i < ts.length; i++) if (ts[i] >= temp) { const f = ts[i] === ts[i - 1] ? 0 : (temp - ts[i - 1]) / (ts[i] - ts[i - 1]); return Math.round((ks[i - 1] + f * 50) / 50) * 50; }
  return ks[ks.length - 1];
}

// tintAdd is in slider units (+ = magenta), correcting for illuminants that sit off the blackbody line
export const WB_PRESETS = [
  { id: 'daylight', name: 'Daylight', K: 5500, tintAdd: 1 },
  { id: 'cloudy', name: 'Cloudy', K: 6500, tintAdd: 2 },
  { id: 'shade', name: 'Shade', K: 7500, tintAdd: 2 },
  { id: 'tungsten', name: 'Tungsten', K: 2850, tintAdd: 0 },
  { id: 'fluorescent', name: 'Fluorescent', K: 3800, tintAdd: 9 },
  { id: 'flash', name: 'Flash', K: 5500, tintAdd: 0 },
];

/** What a preset sets: exactly its Kelvin, whatever the camera. */
export function presetValues(wb, preset) {
  return { wbK: preset.K, temp: 0, tint: preset.tintAdd };
}
