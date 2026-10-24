// Tone curves are natural cubic splines through the points, as in Lightroom (measured: within 0.05 of 255 on its exports),
// clamped to 0..1. A spline can overshoot between points; the clamp keeps the result in range like Lightroom does.
const cache = new WeakMap();
function spline(pts) {
  const n = pts.length, x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  const h = [], al = new Array(n).fill(0), l = new Array(n).fill(1), mu = new Array(n).fill(0), z = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) h[i] = x[i + 1] - x[i];
  for (let i = 1; i < n - 1; i++) al[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i]; z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  const c = new Array(n).fill(0), b = [], d = [];
  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (y[j + 1] - y[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  return { x, y, b, c, d };
}
export function evalCurve(pts, x) {
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let sp = cache.get(pts);
  if (!sp || sp.n !== n || sp.sig !== pts.map((p) => p[0] + ',' + p[1]).join(';')) {
    sp = spline(pts); sp.n = n; sp.sig = pts.map((p) => p[0] + ',' + p[1]).join(';'); cache.set(pts, sp);
  }
  let i = 0;
  while (x > pts[i + 1][0]) i++;
  const t = x - sp.x[i];
  return Math.min(1, Math.max(0, sp.y[i] + sp.b[i] * t + sp.c[i] * t * t + sp.d[i] * t * t * t));
}
export const curveIsIdentity = (pts) => pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1;
export const curvesActive = (c) => !(curveIsIdentity(c.rgb) && curveIsIdentity(c.r) && curveIsIdentity(c.g) && curveIsIdentity(c.b));
