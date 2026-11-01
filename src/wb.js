// White balance for RAW files in Kelvin, computed from the camera's own colour data: what a white surface looks like under an
// illuminant of colour temperature K, as rendered with the as-shot white balance.
import { wbFromLinear } from './analyze.js';
import { TUNE } from './tuning.js';

// The model is the DNG specification's (Adobe's, used by Lightroom): temperature + tint <-> CIE xy through Robertson's isotherm
// table, and an XYZ -> camera matrix blended between the tungsten and daylight matrices by inverse temperature. Tint is in
// Lightroom's units (+ = magenta) and is part of the illuminant, so Kelvin and tint numbers mean what they mean in Lightroom.
const ROB = [[0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479], [20, 0.18133, 0.26846, -0.26876], [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.30470], [50, 0.18388, 0.27709, -0.32675], [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915],
  [80, 0.18740, 0.28668, -0.40955], [90, 0.18880, 0.28997, -0.44278], [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901], [200, 0.21142, 0.32312, -1.0182], [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298], [300, 0.24010, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641], [375, 0.26400, 0.35200, -3.5814], [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955], [500, 0.30505, 0.35907, -11.324], [525, 0.31320, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.770], [600, 0.33724, 0.36051, -116.45]];
const TINT_SCALE = -3000;

/** CIE xy of temperature K with tint (Lightroom units). */
export function tempTintToXy(K, tint = 0) {
  const r = 1e6 / K, off = tint / TINT_SCALE;
  for (let i = 0; i < 30; i++) {
    if (r < ROB[i + 1][0] || i === 29) {
      const f = (ROB[i + 1][0] - r) / (ROB[i + 1][0] - ROB[i][0]);
      let u = ROB[i][1] * f + ROB[i + 1][1] * (1 - f), v = ROB[i][2] * f + ROB[i + 1][2] * (1 - f);
      const l1 = Math.hypot(1, ROB[i][3]), l2 = Math.hypot(1, ROB[i + 1][3]);
      let du = f / l1 + (1 - f) / l2, dv = ROB[i][3] / l1 * f + ROB[i + 1][3] / l2 * (1 - f);
      const l3 = Math.hypot(du, dv); du /= l3; dv /= l3;
      u += du * off; v += dv * off;
      return [1.5 * u / (u - 4 * v + 2), v / (u - 4 * v + 2)];
    }
  }
}

/** Temperature and tint (Lightroom units) of a CIE xy. */
export function xyToTempTint([x, y]) {
  const u = 2 * x / (1.5 - x + 6 * y), v = 3 * y / (1.5 - x + 6 * y);
  let lastDt = 0, lastDu = 0, lastDv = 0;
  for (let i = 1; i <= 30; i++) {
    let du = 1, dv = ROB[i][3]; const len = Math.hypot(du, dv); du /= len; dv /= len;
    let dt = -(u - ROB[i][1]) * dv + (v - ROB[i][2]) * du;
    if (dt <= 0 || i === 30) {
      dt = -Math.min(dt, 0);
      const f = i === 1 ? 0 : dt / (lastDt + dt);
      const K = 1e6 / (ROB[i - 1][0] * f + ROB[i][0] * (1 - f));
      const uu = u - (ROB[i - 1][1] * f + ROB[i][1] * (1 - f)), vv = v - (ROB[i - 1][2] * f + ROB[i][2] * (1 - f));
      du = du * (1 - f) + lastDu * f; dv = dv * (1 - f) + lastDv * f;
      const l = Math.hypot(du, dv);
      return { K, tint: (uu * du / l + vv * dv / l) * TINT_SCALE };
    }
    lastDt = dt; lastDu = du; lastDv = dv;
  }
}

const mulv = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, (c * h - b * i) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, (c * d - a * f) / det], [C / det, (b * g - a * h) / det, (a * e - b * d) / det]];
}
const D50 = [0.9642, 1, 0.8249], T_A = 2856, T_D65 = 6504;
const norm = (M) => { const m = Math.max(...mulv(M, D50)); return M.map((r) => r.map((v) => v / m)); };
const rows = (a) => [a.slice(0, 3), a.slice(3, 6), a.slice(6, 9)];

/** XYZ -> camera matrix for a white of chromaticity xy: tungsten and daylight matrices blended by inverse temperature (DNG). */
function blendWeight(xy) {
  const { K } = xyToTempTint(xy);
  return K <= T_A ? 1 : K >= T_D65 ? 0 : (1 / K - 1 / T_D65) / (1 / T_A - 1 / T_D65);
}
function xyzToCam(wb, xy) {
  if (!wb.cmA) return wb.camXyz;
  const g = blendWeight(xy);
  const A = wb._nA ||= norm(rows(wb.cmA)), D = wb._nD ||= norm(rows(wb.cmD));
  return A.map((r, i) => r.map((v, j) => g * v + (1 - g) * D[i][j]));
}

/** CIE xy of the light that a camera-neutral colour (raw values that should come out grey) corresponds to (DNG NeutralToXY). */
function neutralToXy(wb, n) {
  let last = [0.3457, 0.3585];
  for (let pass = 0; pass < 30; pass++) {
    const X = mulv(inv3(xyzToCam(wb, last)), n), sum = X[0] + X[1] + X[2];
    let next = [X[0] / sum, X[1] / sum];
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 1e-7) return next;
    if (pass === 29) next = [(last[0] + next[0]) / 2, (last[1] + next[1]) / 2];
    last = next;
  }
  return last;
}

/** Lightroom's as-shot temperature and tint, from the camera's as-shot multipliers. */
export function asShot(wb) {
  if (!wb._as) { const t = xyToTempTint(neutralToXy(wb, wb.camMul.map((v) => 1 / v))); wb._as = { K: Math.round(t.K / 50) * 50, tint: Math.round(t.tint), xy: null }; }
  return wb._as;
}
export const asShotKelvin = (wb) => asShot(wb).K;

/** Raw camera response to a white surface under light xy, scaled so the largest channel is 1 and each channel pinned to
 *  0.001..1, as Lightroom does (dng_color_spec SetWhiteXY, confirmed in Camera Raw). Far from the blackbody line (high tint at
 *  warm temperatures) a channel can reach zero or go negative; without the pin the gains blew up and flipped sign. */
const camWhite = (wb, xy) => {
  const n = mulv(xyzToCam(wb, xy), xyToXYZ(xy)), m = Math.max(...n);
  return n.map((v) => Math.min(1, Math.max(0.001, v / m)));
};

/** Linear sRGB colour of a white surface under light xy, as rendered with the as-shot white balance. */
function whiteUnderAsShot(wb, xy) {
  const m = wb.camMul.map((v) => v / wb.camMul[1]);          // as-shot multipliers (green = 1)
  return mulv(wb.rgbCam, camWhite(wb, xy).map((v, i) => v * m[i]));
}

const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const BRAD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]], BRAD_I = inv3(BRAD);
const D65 = [0.95047, 1, 1.08883];
const SRGB = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]], SRGB_I = inv3(SRGB);
/** Bradford adaptation XYZ under white s -> XYZ under white d. */
function bradford(s0, d0) {
  const s = mulv(BRAD, s0), d = mulv(BRAD, d0);
  const r = (i) => (s[i] > 0 ? Math.min(10, Math.max(0.1, Math.max(d[i], 0) / s[i])) : 10);   // Lightroom pins the cone ratios to 0.1..10
  return mul3(BRAD_I, mul3([[r(0), 0, 0], [0, r(1), 0], [0, 0, r(2)]], BRAD));
}
const D50_TO_SRGB = mul3(SRGB, bradford(D50, D65));
/** White-balanced camera -> XYZ D50 for light xy: the blended forward matrix, scaled so camera white lands on D50 (DNG). */
function forward(wb, xy) {
  const g = blendWeight(xy), A = rows(wb.fmA), D = rows(wb.fmD);
  const F = A.map((r, i) => r.map((v, j) => g * v + (1 - g) * D[i][j]));
  const w = mulv(F, [1, 1, 1]);
  return F.map((r, i) => r.map((v) => v * D50[i] / w[i]));
}
/** Camera raw -> linear sRGB for a scene lit by xy: white balance in camera space, then the forward matrix (as Lightroom renders). */
function camToSrgb(wb, xy) {
  const n = camWhite(wb, xy);
  return mul3(D50_TO_SRGB, mul3(forward(wb, xy), [[n[1] / n[0], 0, 0], [0, 1, 0], [0, 0, n[1] / n[2]]]));
}

/** White balance change as a 3x3 matrix (row-major, linear sRGB, applied to the as-shot picture) that makes it look as if the light
 *  had been K with tint `tint` (Lightroom's numbers) instead of the as-shot light. With forward matrices the camera's colour
 *  rendering follows the light as in Lightroom; otherwise the channels are rescaled in camera space (sRGB -> camera -> sRGB),
 *  which stays sane for big shifts where per-sRGB-channel gains flip. */
export function kelvinGains(wb, K, tint) {
  const as = asShot(wb);
  const xy0 = (as.xy ||= neutralToXy(wb, wb.camMul.map((v) => 1 / v)));
  const xy = tempTintToXy(Math.max(1700, Math.min(50000, K || as.K)), Math.max(-150, Math.min(150, tint ?? as.tint)));
  const n0 = camWhite(wb, xy0), n = camWhite(wb, xy);
  const g = n0.map((v, i) => v / n[i]).map((v, _, a) => v / a[1]);
  const C = wb.rgbCam, Ci = wb._rgbCamInv ||= inv3(C);
  const Md = mul3(mul3(C, [[g[0], 0, 0], [0, g[1], 0], [0, 0, g[2]]]), Ci);
  if (!(wb.fmA && wb.fmD)) return Md.flat();
  const Mf = mul3(camToSrgb(wb, xy), inv3(camToSrgb(wb, xy0)));
  // The camera-space rescale goes through libraw's matrix, which at extreme settings (warm + strong tint) turns grey into negative
  // red / green and a negative brightness; the shader then flipped the picture. Fade it out before that happens, judged by the
  // brightness it gives grey compared with the forward-matrix path: ordinary edits stay above 0.75 and keep the full blend.
  const Y = (M) => 0.2126 * (M[0][0] + M[0][1] + M[0][2]) + 0.7152 * (M[1][0] + M[1][1] + M[1][2]) + 0.0722 * (M[2][0] + M[2][1] + M[2][2]);
  const r = Y(Md) / Math.max(Y(Mf), 1e-6);
  const t = (TUNE.wbMix ?? 0) * Math.min(1, Math.max(0, (r - 0.3) / 0.4));
  return Mf.map((r, i) => r.map((v, j) => v * (1 - t) + Md[i][j] * t)).flat();
}

/** Gains for a photo's params: Kelvin (0 = as shot) and the tint slider, which on a RAW is an offset from the as-shot tint. */
export const paramGains = (wb, p) => kelvinGains(wb, p.wbK || asShot(wb).K, asShot(wb).tint + (p.tint || 0));

/** Best { wbK, tint } for a picture patch (linear sRGB, as shot) that should come out neutral. */
export function kelvinFromNeutral(wb, [r, g, b]) {
  const rgb = [Math.max(r, 1e-4), Math.max(g, 1e-4), Math.max(b, 1e-4)];
  const m = wb.camMul.map((v) => v / wb.camMul[1]);
  const cam = mulv(inv3(wb.rgbCam), rgb).map((v, i) => Math.max(v, 1e-6) / m[i]);   // back to raw camera values
  const t = xyToTempTint(neutralToXy(wb, cam)), as = asShot(wb);
  const K = Math.round(Math.max(2000, Math.min(50000, t.K)) / 50) * 50;
  return { wbK: K === as.K ? 0 : K, temp: 0, tint: Math.max(-150, Math.min(150, Math.round(t.tint))) - as.tint };
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
  for (let K = 2000; K <= 25000; K += 50) { ks.push(K); ts.push(wbFromLinear(whiteUnderAsShot(wb, tempTintToXy(K, asShot(wb).tint)), true).temp); }
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
