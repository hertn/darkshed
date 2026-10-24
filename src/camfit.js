// "Camera Matching" profile: fits DarkShed's neutral RAW render to the JPEG the camera stored inside the RAW file, per channel,
// so the picture takes on the camera maker's own look. Works for any camera, with no profile database.
import LibRaw from 'libraw-wasm';
import { TUNE, rawCamStops } from './tuning.js';

const K = 17;                      // knots over 0..1, red / green / blue, same layout as the per-camera curves in tuning.js
const SAMPLES = 40000;

/** Same as the shader's baseEnc: linear value -> display value through the RAW base curve (one channel). */
function baseEnc(lin, ch) {
  const x = Math.min(23.999, Math.max(0, (Math.log2(Math.max(lin, 1e-6)) - TUNE.rawX0) / TUNE.rawDx));
  const i = Math.floor(x), f = x - i, t = TUNE.rawBase;
  return t[i * 3 + ch] + (t[(i + 1) * 3 + ch] - t[i * 3 + ch]) * f;
}

/** Pool-adjacent-violators: the closest non-decreasing sequence. */
function isotonic(ys) {
  const out = [];
  for (const y of ys) {
    out.push([y, 1]);
    while (out.length > 1 && out[out.length - 2][0] / out[out.length - 2][1] > out[out.length - 1][0] / out[out.length - 1][1]) {
      const a = out.pop(), b = out.pop(); out.push([a[0] + b[0], a[1] + b[1]]);
    }
  }
  const f = [];
  for (const [s, n] of out) for (let i = 0; i < n; i++) f.push(s / n);
  return f;
}

/** Quantile-match one channel (ours -> the camera's) and sample the result at K knots; identity towards black and white outside the data. */
function channelKnots(ours, theirs) {
  ours.sort((a, b) => a - b); theirs.sort((a, b) => a - b);
  const N = 400, pts = [];
  for (let i = 0; i < N; i++) {
    const q = (i + 0.5) / N;
    pts.push([ours[Math.min(ours.length - 1, Math.floor(q * ours.length))], theirs[Math.min(theirs.length - 1, Math.floor(q * theirs.length))]]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0]), f = isotonic(pts.map((p) => p[1]));
  const lo = xs[0], hi = xs[xs.length - 1], col = [];
  for (let j = 0; j < K; j++) {
    const x = j / (K - 1);
    let v;
    if (x < lo) v = lo > 0.02 ? x * (f[0] / lo) : x;
    else if (x > hi) v = f[f.length - 1] + (1 - f[f.length - 1]) * ((x - hi) / Math.max(1 - hi, 1e-6));
    else {
      let i = 0; while (i < xs.length - 1 && xs[i] < x) i++;
      const a = Math.max(0, i - 12), b = Math.min(f.length, i + 13);
      v = f.slice(a, b).reduce((s, n) => s + n, 0) / (b - a);
    }
    col.push(Math.min(1, Math.max(0, v)));
  }
  for (let j = 1; j < K; j++) col[j] = Math.max(col[j], col[j - 1]);
  return col;
}

/** Float32Array(K * 3) of knots, or null when the file has no usable embedded JPEG. */
async function fitFile(file) {
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(await file.arrayBuffer()), { halfSize: true, useCameraWb: true, outputBps: 16, outputColor: 1, noAutoBright: true, gamm: [1, 1], userQual: 0, highlight: 0 });
    const meta = await raw.metadata(true);
    const camera = `${meta.camera_make || ''} ${meta.camera_model || ''}`.trim();
    const t = await raw.thumbnailData();
    if (!t || t.format !== 'jpeg') return null;
    const d = await raw.imageData();
    const bmp = await createImageBitmap(new Blob([t.data], { type: 'image/jpeg' }));
    const sw = 256, sh = Math.max(1, Math.round(256 * bmp.height / bmp.width));
    const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0, sw, sh);
    const cam = cx.getImageData(0, 0, sw, sh).data;
    const off = Math.pow(2, rawCamStops(camera)), ch = d.colors || 3;
    const n = d.width * d.height, step = Math.max(1, Math.floor(n / SAMPLES));
    const ours = [[], [], []], theirs = [[], [], []];
    for (let p = 0; p < n; p += step) for (let c = 0; c < 3; c++) ours[c].push(baseEnc(d.data[p * ch + c] / 65535 * off, c));
    for (let p = 0; p < sw * sh; p++) for (let c = 0; c < 3; c++) theirs[c].push(cam[p * 4 + c] / 255);
    const cols = [0, 1, 2].map((c) => channelKnots(ours[c], theirs[c]));
    const out = new Float32Array(K * 3);
    for (let j = 0; j < K; j++) for (let c = 0; c < 3; c++) out[j * 3 + c] = cols[c][j];
    return out;
  } finally { raw.dispose(); }
}

/** Fits the camera look for a photo once and keeps it on the item (not saved): it.camFit is a Float32Array, or null if impossible. */
export function ensureCamFit(it) {
  if (it.camFit !== undefined) return Promise.resolve(it.camFit);
  return (it.camFitP ||= fitFile(it.file).then((r) => (it.camFit = r), (e) => { console.warn('camera look fit failed', e); return (it.camFit = null); }));
}
