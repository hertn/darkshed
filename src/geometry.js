// Crop / rotate / straighten / flip maths.
//
// Units: the source image is A x 1 ("height units", A = width / height), origin top-left, y down.
// The output ("O") frame is the image after flip + rotation by theta, centred on the image centre.
//   O = F * R(theta) * (S - centre)      S = centre + R(-theta) * F * O
// The crop rect lives in the O frame: { cx, cy, w, h } relative to the image centre.

const rad = (d) => (d * Math.PI) / 180;

export const thetaOf = (crop) => rad(crop.rot90 * 90 + crop.angle);

/** Half extents of the rotated image's bounding box in the O frame. */
export function frameHalf(crop, A) {
  const t = thetaOf(crop), c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return [c * (A / 2) + s * 0.5, s * (A / 2) + c * 0.5];
}

/** M = R(-theta) * F as [m00, m01, m10, m11] (row-major). */
function matM(crop) {
  const t = thetaOf(crop), c = Math.cos(t), s = Math.sin(t);
  const fx = crop.flipH ? -1 : 1, fy = crop.flipV ? -1 : 1;
  return [c * fx, s * fy, -s * fx, c * fy];
}
const mul = (m, x, y) => [m[0] * x + m[1] * y, m[2] * x + m[3] * y];

/** Largest s >= 0 with |a + s*b| <= L (per component pair). */
function maxScale(a, b, L) {
  let s = Infinity;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(a[k]) > L[k] + 1e-9) return 0;
    if (b[k] > 1e-12) s = Math.min(s, (L[k] - a[k]) / b[k]);
    else if (b[k] < -1e-12) s = Math.min(s, (-L[k] - a[k]) / b[k]);
  }
  return s;
}
const corners = (r) => [[-r.w / 2, -r.h / 2], [r.w / 2, -r.h / 2], [r.w / 2, r.h / 2], [-r.w / 2, r.h / 2]];

/** Is every corner of rect (O frame) inside the image? */
export function rectInside(crop, A, r, eps = 1e-6) {
  const M = matM(crop), L = [A / 2 + eps, 0.5 + eps];
  return corners(r).every(([dx, dy]) => {
    const [x, y] = mul(M, r.cx + dx, r.cy + dy);
    return Math.abs(x) <= L[0] && Math.abs(y) <= L[1];
  });
}

/** Scale rect about its centre until it fits inside the image. */
export function fitInside(crop, A, r) {
  const M = matM(crop), L = [A / 2, 0.5];
  const a = mul(M, r.cx, r.cy);
  let s = 1;
  for (const [dx, dy] of corners(r)) {
    const b = mul(M, dx, dy);
    s = Math.min(s, maxScale(a, b, L));
  }
  s = Math.max(0, s);
  return { cx: r.cx, cy: r.cy, w: r.w * s, h: r.h * s };
}

/** Move rect by (dx,dy) as far as it can go while staying inside the image (slides along edges). */
export function moveInside(crop, A, r, dx, dy) {
  const M = matM(crop), L = [A / 2, 0.5];
  const attempt = (rr, ddx, ddy) => {
    const a0 = mul(M, rr.cx, rr.cy), bd = mul(M, ddx, ddy);
    let t = 1;
    for (const [cx, cy] of corners(rr)) {
      const a = mul(M, rr.cx + cx, rr.cy + cy), b = bd;
      t = Math.min(t, maxScale(a, b, L));
    }
    void a0;
    t = Math.max(0, t);
    return { ...rr, cx: rr.cx + ddx * t, cy: rr.cy + ddy * t };
  };
  let out = attempt(r, dx, dy);
  // if the diagonal move was clipped, try sliding along each axis with what is left
  const remX = dx - (out.cx - r.cx), remY = dy - (out.cy - r.cy);
  if (Math.abs(remX) > 1e-9) out = attempt(out, remX, 0);
  if (Math.abs(remY) > 1e-9) out = attempt(out, 0, remY);
  return out;
}

/** Aspect (w/h) of the image in the O frame before any crop, ignoring straighten. */
export const baseAspect = (crop, A) => (crop.rot90 % 2 ? 1 / A : A);

export function aspectValue(crop, A) {
  const a = crop.aspect;
  if (a === 'orig') return baseAspect(crop, A);
  if (a === 'free' || !a) return null;
  const [w, h] = a.split(':').map(Number);
  return w / h;
}

/** Default crop rect: whole frame when straight, otherwise the largest inscribed rect with the base aspect. */
export function defaultRect(crop, A) {
  const [hx, hy] = frameHalf(crop, A);
  if (!crop.angle) return { cx: 0, cy: 0, w: 2 * hx, h: 2 * hy };
  const asp = baseAspect(crop, A);
  const big = { cx: 0, cy: 0, w: asp * 2 * hy, h: 2 * hy };
  return fitInside(crop, A, big);
}

export const cropRect = (crop, A) => crop.rect || defaultRect(crop, A);

/** Largest rect of the given aspect (w/h) inside the image, centred where the old rect was. */
export function rectForAspect(crop, A, old, asp) {
  const [, hy] = frameHalf(crop, A);
  const base = { cx: old.cx, cy: old.cy, w: asp * 2 * hy, h: 2 * hy };
  let r = fitInside(crop, A, base);
  if (r.w < 1e-4) r = fitInside(crop, A, { cx: 0, cy: 0, w: base.w, h: base.h });
  return r;
}

export function isCropped(crop, A) {
  if (!crop) return false;
  if (crop.angle || crop.rot90 || crop.flipH || crop.flipV) return true;
  if (!crop.rect) return false;
  const d = defaultRect(crop, A);
  const r = crop.rect;
  return Math.abs(r.w - d.w) > 1e-4 || Math.abs(r.h - d.h) > 1e-4 || Math.abs(r.cx) > 1e-4 || Math.abs(r.cy) > 1e-4;
}

/**
 * Everything the renderer and the overlays need.
 * frameMode: show the whole rotated frame instead of the crop (used while the crop tool is open).
 */
export function makeGeo(crop, A, frameMode = false) {
  const M = matM(crop);
  let rect;
  if (frameMode) { const [hx, hy] = frameHalf(crop, A); rect = { cx: 0, cy: 0, w: 2 * hx, h: 2 * hy }; }
  else rect = cropRect(crop, A);
  const theta = thetaOf(crop);
  // inverse of M (R(-t) F)^-1 = F R(t)
  const c = Math.cos(theta), s = Math.sin(theta), fx = crop.flipH ? -1 : 1, fy = crop.flipV ? -1 : 1;
  const Mi = [fx * c, -fx * s, fy * s, fy * c];
  return {
    A, rect, theta, outAspect: rect.w / rect.h,
    // mat2 uniform, column-major
    uM: [M[0], M[2], M[1], M[3]], uC: [rect.cx, rect.cy], uSz: [rect.w, rect.h],
    /** source (height units) -> output uv (0..1, y down) */
    srcToOut(x, y) {
      const [ox, oy] = mul(Mi, x - A / 2, y - 0.5);
      return [(ox - rect.cx) / rect.w + 0.5, (oy - rect.cy) / rect.h + 0.5];
    },
    /** output uv -> source (height units) */
    outToSrc(u, v) {
      const [sx, sy] = mul(M, rect.cx + (u - 0.5) * rect.w, rect.cy + (v - 0.5) * rect.h);
      return [sx + A / 2, sy + 0.5];
    },
    /** O-frame point (relative to image centre) -> output uv */
    oToOut(ox, oy) { return [(ox - rect.cx) / rect.w + 0.5, (oy - rect.cy) / rect.h + 0.5]; },
    outToO(u, v) { return [rect.cx + (u - 0.5) * rect.w, rect.cy + (v - 0.5) * rect.h]; },
  };
}

/** Rotate the crop rect with the image by +90 degrees (clockwise). */
export function rotate90(crop, dir = 1) {
  const r = crop.rect;
  crop.rot90 = (crop.rot90 + (dir > 0 ? 1 : 3)) % 4;
  if (r) crop.rect = dir > 0 ? { cx: -r.cy, cy: r.cx, w: r.h, h: r.w } : { cx: r.cy, cy: -r.cx, w: r.h, h: r.w };
  if (crop.aspect && crop.aspect.includes(':') && crop.aspect !== 'orig') { const [w, h] = crop.aspect.split(':'); crop.aspect = `${h}:${w}`; }
}
export function flip(crop, axis) {
  const r = crop.rect;
  if (axis === 'h') { crop.flipH = !crop.flipH; if (r) crop.rect = { ...r, cx: -r.cx }; }
  else { crop.flipV = !crop.flipV; if (r) crop.rect = { ...r, cy: -r.cy }; }
}
