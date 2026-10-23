// Spot removal (heal / clone). Spots live in source "height units"; this patches pixels for the working copy and for export.
import { h2f } from './analyze.js';
import { toHalf } from './decode.js';

export const newSpot = (o) => ({ id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), mode: 'heal', feather: 0.5, opacity: 1, ...o });

const H2F = (() => { const t = new Float32Array(65536); for (let i = 0; i < 65536; i++) t[i] = h2f(i); return t; })();
const S2L = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const s = i / 255; t[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); } return t; })();
const l2s = (c) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };

/** Accessors: get(x, y, out) fills out with linear RGB; set(x, y, rgb). */
export const accessHalf = (a, w) => ({
  get(x, y, o) { const i = (y * w + x) * 4; o[0] = H2F[a[i]]; o[1] = H2F[a[i + 1]]; o[2] = H2F[a[i + 2]]; },
  set(x, y, c) { const i = (y * w + x) * 4; a[i] = toHalf(c[0]); a[i + 1] = toHalf(c[1]); a[i + 2] = toHalf(c[2]); },
});
export const accessRgb16 = (a, w, ch) => ({
  get(x, y, o) { const i = (y * w + x) * ch; o[0] = a[i] / 65535; o[1] = a[i + 1] / 65535; o[2] = a[i + 2] / 65535; },
  set(x, y, c) { const i = (y * w + x) * ch; a[i] = Math.max(0, Math.min(65535, Math.round(c[0] * 65535))); a[i + 1] = Math.max(0, Math.min(65535, Math.round(c[1] * 65535))); a[i + 2] = Math.max(0, Math.min(65535, Math.round(c[2] * 65535))); },
});
export const accessRgba8 = (a, w) => ({
  get(x, y, o) { const i = (y * w + x) * 4; o[0] = S2L[a[i]]; o[1] = S2L[a[i + 1]]; o[2] = S2L[a[i + 2]]; },
  set(x, y, c) { const i = (y * w + x) * 4; a[i] = l2s(c[0]); a[i + 1] = l2s(c[1]); a[i + 2] = l2s(c[2]); },
});

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6))); return t * t * (3 - 2 * t); };

function makeSampler(w, h, acc) {
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];
  return (fx, fy, out) => {
    const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5), tx = fx - 0.5 - x0, ty = fy - 0.5 - y0;
    const cx = (v) => Math.min(w - 1, Math.max(0, v)), cy = (v) => Math.min(h - 1, Math.max(0, v));
    acc.get(cx(x0), cy(y0), a); acc.get(cx(x0 + 1), cy(y0), b); acc.get(cx(x0), cy(y0 + 1), c); acc.get(cx(x0 + 1), cy(y0 + 1), d);
    for (let k = 0; k < 3; k++) out[k] = (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty;
  };
}

export const newStroke = (o) => ({ id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), kind: 'stroke', mode: 'heal', feather: 0.5, opacity: 1, pts: [], r: 0.03, off: [0.1, 0], ...o });

/** Dab centres (px) along a stroke, spaced so the dabs overlap. */
function strokeDabs(pts, r) {
  const step = Math.max(1, r * 0.3), out = [];
  if (pts.length === 1) return [pts[0].slice()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (!len) continue;
    let d = carry;
    while (d <= len) { out.push([ax + (dx * d) / len, ay + (dy * d) / len]); d += step; }
    carry = d - len;
  }
  return out.length ? out : [pts[0].slice()];
}

/**
 * Pick where a stroke (or spot) should sample from: the nearby area whose surroundings look most like the surroundings of the
 * target, so the patch blends in. pts / result in height units, w x h is the image the accessor reads.
 */
export function bestSource(w, h, acc, pts, r) {
  const P = pts.map(([x, y]) => [x * h, y * h]), R = Math.max(2, r * h);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x - R); y0 = Math.min(y0, y - R); x1 = Math.max(x1, x + R); y1 = Math.max(y1, y + R); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, reach = Math.hypot(rx, ry);
  const sample = makeSampler(w, h, acc), a = [0, 0, 0], b = [0, 0, 0];
  const ringPts = [];
  for (let k = 0; k < 28; k++) { const t = (k / 28) * Math.PI * 2; ringPts.push([cx + Math.cos(t) * (rx + R * 0.7 + 3), cy + Math.sin(t) * (ry + R * 0.7 + 3)]); }
  let best = null;
  for (const mult of [1.15, 1.6, 2.2, 3.0]) for (let k = 0; k < 16; k++) {
    const t = (k / 16) * Math.PI * 2, ox = Math.cos(t) * (reach + R) * mult, oy = Math.sin(t) * (reach + R) * mult;
    if (x0 + ox < 0 || y0 + oy < 0 || x1 + ox > w || y1 + oy > h) continue;               // source box must be inside the photo
    let err = 0, n = 0;
    for (const [px, py] of ringPts) {
      const sx = px + ox, sy = py + oy;
      if (px < 0 || py < 0 || px >= w || py >= h || sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      sample(px, py, a); sample(sx, sy, b);
      err += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); n++;
    }
    if (n < 8) continue;
    err = err / n * (1 + 0.12 * mult);                                                      // slight preference for close sources
    if (!best || err < best.err) best = { err, ox, oy };
  }
  if (!best) return [Math.min(0.2, (w / h) * 0.3), 0];
  return [best.ox / h, best.oy / h];
}

/** Heal / clone along a painted stroke: one offset for the whole stroke, colour matched to the surroundings. */
function patchStroke(w, h, acc, sp) {
  const r = Math.max(1, sp.r * h), pts = sp.pts.map(([x, y]) => [x * h, y * h]), dabs = strokeDabs(pts, r);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of dabs) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw <= 0 || bh <= 0) return;
  const cov = new Float32Array(bw * bh), inner = Math.min(0.995, 1 - sp.feather);
  for (const [dx, dy] of dabs) {
    const ya = Math.max(y0, Math.floor(dy - r)), yb = Math.min(y1, Math.ceil(dy + r)), xa = Math.max(x0, Math.floor(dx - r)), xb = Math.min(x1, Math.ceil(dx + r));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const d = Math.hypot(x + 0.5 - dx, y + 0.5 - dy) / r;
      if (d >= 1) continue;
      const v = 1 - smooth(inner, 1, d), i = (y - y0) * bw + (x - x0);
      if (v > cov[i]) cov[i] = v;
    }
  }
  const ox = sp.off[0] * h, oy = sp.off[1] * h, sample = makeSampler(w, h, acc), t1 = [0, 0, 0], s1 = [0, 0, 0];
  const delta = [0, 0, 0];
  if (sp.mode === 'heal') {
    let n = 0;
    for (let k = 0; k < dabs.length; k += Math.max(1, Math.floor(dabs.length / 24))) for (let a = 0; a < 10; a++) {
      const t = (a / 10) * Math.PI * 2, px = dabs[k][0] + Math.cos(t) * r * 1.3, py = dabs[k][1] + Math.sin(t) * r * 1.3;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const ix = Math.floor(px) - x0, iy = Math.floor(py) - y0;
      if (ix >= 0 && iy >= 0 && ix < bw && iy < bh && cov[iy * bw + ix] > 0.05) continue;       // inside the painted area
      if (px + ox < 0 || py + oy < 0 || px + ox >= w || py + oy >= h) continue;
      sample(px, py, t1); sample(px + ox, py + oy, s1);
      for (let c = 0; c < 3; c++) delta[c] += t1[c] - s1[c];
      n++;
    }
    if (n) for (let c = 0; c < 3; c++) delta[c] /= n; else delta.fill(0);
  }
  const out = [], cur = [0, 0, 0], src = [0, 0, 0];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = cov[(y - y0) * bw + (x - x0)] * sp.opacity;
    if (v <= 0.003) continue;
    sample(x + 0.5 + ox, y + 0.5 + oy, src); acc.get(x, y, cur);
    out.push(x, y, Math.max(0, cur[0] + (src[0] + delta[0] - cur[0]) * v), Math.max(0, cur[1] + (src[1] + delta[1] - cur[1]) * v), Math.max(0, cur[2] + (src[2] + delta[2] - cur[2]) * v));
  }
  const c = [0, 0, 0];
  for (let i = 0; i < out.length; i += 5) { c[0] = out[i + 2]; c[1] = out[i + 3]; c[2] = out[i + 4]; acc.set(out[i], out[i + 1], c); }
}

/** Patch an image in place through its accessor. w, h in px; spot geometry is in units of the image height. */
export function patchImage(w, h, acc, spots) {
  const tmp = [0, 0, 0];
  const sampleBilinear = makeSampler(w, h, acc);
  for (const sp of spots) {
    if (sp.kind === 'stroke') { patchStroke(w, h, acc, sp); continue; }
    const r = Math.max(1, sp.r * h), cx = sp.x * h, cy = sp.y * h, dx = (sp.sx - sp.x) * h, dy = (sp.sy - sp.y) * h;
    const delta = [0, 0, 0];
    if (sp.mode === 'heal') {
      // colour difference between the rings around the target and the source, so the patch blends in
      const ring = (ox, oy) => {
        const m = [0, 0, 0]; let n = 0;
        for (let k = 0; k < 40; k++) for (const rr of [1.1, 1.3]) {
          const a = (k / 40) * Math.PI * 2, x = Math.round(ox + Math.cos(a) * r * rr), y = Math.round(oy + Math.sin(a) * r * rr);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          acc.get(x, y, tmp); m[0] += tmp[0]; m[1] += tmp[1]; m[2] += tmp[2]; n++;
        }
        return n ? m.map((v) => v / n) : null;
      };
      const a = ring(cx, cy), b = ring(cx + dx, cy + dy);
      if (a && b) for (let c = 0; c < 3; c++) delta[c] = a[c] - b[c];
    }
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d >= 1) continue;
      const wgt = sp.opacity * (1 - smooth(Math.min(0.995, 1 - sp.feather), 1, d));
      if (wgt <= 0.003) continue;
      const src = [0, 0, 0];
      sampleBilinear(x + 0.5 + dx, y + 0.5 + dy, src);
      acc.get(x, y, tmp);
      out.push(x, y, Math.max(0, tmp[0] + (src[0] + delta[0] - tmp[0]) * wgt), Math.max(0, tmp[1] + (src[1] + delta[1] - tmp[1]) * wgt), Math.max(0, tmp[2] + (src[2] + delta[2] - tmp[2]) * wgt));
    }
    const c = [0, 0, 0];
    for (let i = 0; i < out.length; i += 5) { c[0] = out[i + 2]; c[1] = out[i + 3]; c[2] = out[i + 4]; acc.set(out[i], out[i + 1], c); }
  }
}

/** Patched copy of a proxy (RGBA half floats). Returns the original array when there are no spots. */
export function patchedHalf(half, w, h, spots) {
  if (!spots?.length) return half;
  const copy = half.slice();
  patchImage(w, h, accessHalf(copy, w), spots);
  return copy;
}

export const spotSig = (spots) => JSON.stringify((spots || []).map((s) => (s.kind === 'stroke' ? [s.kind, s.pts.length, s.pts[0], s.pts[s.pts.length - 1], s.off, s.r, s.feather, s.opacity, s.mode] : [s.x, s.y, s.sx, s.sy, s.r, s.feather, s.opacity, s.mode])));
