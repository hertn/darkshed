// Monotone cubic (Fritsch-Carlson) tone curves, so curves never overshoot.
export function evalCurve(pts, x) {
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let i = 0;
  while (x > pts[i + 1][0]) i++;
  const h = pts[i + 1][0] - pts[i][0], t = (x - pts[i][0]) / h;
  const t2 = t * t, t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h * m[i] +
            (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h * m[i + 1];
  return Math.min(1, Math.max(0, y));
}
export const curveIsIdentity = (pts) => pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1;
export const curvesActive = (c) => !(curveIsIdentity(c.rgb) && curveIsIdentity(c.r) && curveIsIdentity(c.g) && curveIsIdentity(c.b));
