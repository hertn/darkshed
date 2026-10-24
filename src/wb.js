// White balance presets for RAW files, computed from the camera's own colour data.
// For an illuminant of colour temperature K we find what a white surface looks like under the as-shot
// white balance, then ask for the temp / tint that makes that colour neutral (same maths as the picker).
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

/** Estimated colour temperature the camera's as-shot white balance corresponds to. */
export function asShotKelvin(wb) {
  let best = 5500, bestE = Infinity;
  for (let K = 2000; K <= 12000; K += 50) {
    const [r, g, b] = whiteUnderAsShot(wb, K);
    if (r <= 0 || g <= 0 || b <= 0) continue;
    const e = Math.abs(Math.log(r / g)) + Math.abs(Math.log(b / g));
    if (e < bestE) { bestE = e; best = K; }
  }
  return Math.round(best / 50) * 50;
}

// Kelvin <-> temp slider. The slider value that makes illuminant K look neutral rises with K (warmer picture for a higher K),
// so a table of that value over K, built once per photo, converts both ways. Photos show Kelvin like a RAW editor does.
const K_MIN = 2000, K_MAX = 25000, K_STEP = 50;
function kTable(wb) {
  if (wb._kt) return wb._kt;
  const ks = [], ts = [];
  for (let K = K_MIN; K <= K_MAX; K += K_STEP) { ks.push(K); ts.push(wbFromLinear(whiteUnderAsShot(wb, K), true).temp); }
  for (let i = 1; i < ts.length; i++) ts[i] = Math.max(ts[i], ts[i - 1]);       // keep it non-decreasing
  return (wb._kt = { ks, ts });
}
/** Colour temperature (K) a temp slider position stands for. */
export function tempToKelvin(wb, temp) {
  if (!temp) return asShotKelvin(wb);
  const { ks, ts } = kTable(wb);
  if (temp <= ts[0]) return ks[0];
  for (let i = 1; i < ts.length; i++) if (ts[i] >= temp) { const f = ts[i] === ts[i - 1] ? 0 : (temp - ts[i - 1]) / (ts[i] - ts[i - 1]); return Math.round((ks[i - 1] + f * K_STEP) / 10) * 10; }
  return ks[ks.length - 1];
}
/** Temp slider position (-100..100) for a typed colour temperature. */
export function kelvinToTemp(wb, K) {
  const { ks, ts } = kTable(wb);
  const x = Math.max(K_MIN, Math.min(K_MAX, K)), i = Math.min(ks.length - 2, Math.floor((x - K_MIN) / K_STEP));
  const f = (x - ks[i]) / K_STEP;
  return Math.max(-100, Math.min(100, Math.round(ts[i] + f * (ts[i + 1] - ts[i]))));
}

// tintAdd is in slider units (+ = magenta; Lightroom-scale sliders), correcting for illuminants that sit off the blackbody line
export const WB_PRESETS = [
  { id: 'daylight', name: 'Daylight', K: 5500, tintAdd: 1 },
  { id: 'cloudy', name: 'Cloudy', K: 6500, tintAdd: 2 },
  { id: 'shade', name: 'Shade', K: 7500, tintAdd: 2 },
  { id: 'tungsten', name: 'Tungsten', K: 2850, tintAdd: 0 },
  { id: 'fluorescent', name: 'Fluorescent', K: 3800, tintAdd: 9 },
  { id: 'flash', name: 'Flash', K: 5500, tintAdd: 0 },
];

/** { temp, tint } (-100..100) for a preset on this camera. */
export function presetValues(wb, preset) {
  const w = whiteUnderAsShot(wb, preset.K);
  const { temp, tint } = wbFromLinear(w);
  return { temp, tint: Math.max(-100, Math.min(100, Math.round(tint * 0.5) + preset.tintAdd)) };
}
