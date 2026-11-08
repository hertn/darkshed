// Canvas viewport: render loop, zoom / pan / pinch, before-after split, tool overlay + pointer routing.
import { Renderer } from './gl.js';
import { app, curItem, bus, changed, commit, renderState } from './app.js';
import { makeGeo } from './geometry.js';
import { samplePatch, wbFromLinear } from './analyze.js';
import { kelvinFromNeutral } from './wb.js';
import { patchedHalf, spotSig } from './spots.js';

const $ = (id) => document.getElementById(id);
export const canvas = $('cv');
const ov = $('ov');
const hud = $('hud');

let renderer;
export const view = {};
let dirty = false, editDirty = false, geoDirty = true, overlayDirty = true;
const stats = { render: 0, fps: 0, frames: 0, t: performance.now() };
let tool = null;                 // active tool implementation { pointerDown, pointerMove, pointerUp, drawOverlay, cursor }
let wbPicking = false;
// eyedropper cursor (hot spot at the tip), drawn white-outlined so it shows on any photo
const PIPETTE = '<path d="m14 6 4 4"/><path d="m15.5 4.5 1-1a2.1 2.1 0 0 1 3 3l-1 1-3-3z"/><path d="M14.5 8.5 6 17l-1 3 3-1 8.5-8.5"/>';
const svg = (c, w) => `<g fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${PIPETTE}</g>`;
const WB_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">${svg('#fff', 3.8)}${svg('#000', 1.7)}</svg>`)}") 4 28, crosshair`;
const cancelWb = () => { if (wbPicking) { wbPicking = false; canvas.style.cursor = tool?.cursor || ''; } };
let onReadback = () => {};
let ensureLut = () => {};
let rbTimer = 0, rbLast = 0;
let glLost = false;

export function initViewport({ onReadback: rb, ensureLut: el } = {}) {
  onReadback = rb || onReadback; ensureLut = el || ensureLut;
  try { renderer = new Renderer(canvas); } catch (e) { hud.textContent = String(e); hud.classList.add('show'); throw e; }
  app.renderer = renderer;
  // The browser may take the GL context away (iOS does when the app has been in the background). Everything on the
  // GPU is then gone: when it comes back, build a new renderer and upload the photo again.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); glLost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      const keepView = renderer.view;
      renderer = new Renderer(canvas);
      app.renderer = renderer;
      renderer.view = keepView;
      const L = app.loaded;
      if (L) { renderer.setImage(L.img.width, L.img.height, L.img.half, L.img.fullW, L.img.fullH); L.spotSig = null; }
      renderer.invalidateBefore();
      glLost = false;
      geoDirty = true; dirty = true; editDirty = true; overlayDirty = true;
    } catch (err) { hud.textContent = String(err); hud.classList.add('show'); }
  });
  new ResizeObserver(resize).observe(canvas);
  requestAnimationFrame(frame);
  bus.on('changed', (f = {}) => {
    dirty = true;
    if (f.edit) editDirty = true;
    if (f.geo) { geoDirty = true; editDirty = true; }
    if (f.view) overlayDirty = true;
    overlayDirty = true;
  });
  return renderer;
}

// ---------- vectorscope sample box: { x0, y0, x1, y1 } in 0..1 of the uncropped source image (a viewing aid, never part of the edit) ----------
let scopeBox = null, onScopeBox = () => {}, boxDrag = null;
export function setScopeBox(box, onChange) { scopeBox = box; if (onChange) onScopeBox = onChange; overlayDirty = true; dirty = true; }
const boxCorners = () => {
  const A = renderer.geo.A, b = scopeBox;
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([u, v]) => view.srcToPx(u * A, v));
};
function boxHit(x, y, coarse) {
  if (!scopeBox || app.tool !== 'edit') return null;
  const c = boxCorners(), r = coarse ? 22 : 12;
  for (let i = 0; i < 4; i++) if (Math.hypot(c[i][0] - x, c[i][1] - y) < r) return { corner: i };
  let inside = false;                                           // point in the (possibly rotated) box
  for (let i = 0, j = 3; i < 4; j = i++) if ((c[i][1] > y) !== (c[j][1] > y) && x < ((c[j][0] - c[i][0]) * (y - c[i][1])) / (c[j][1] - c[i][1]) + c[i][0]) inside = !inside;
  return inside ? { corner: -1 } : null;
}
const srcUV = (x, y) => { const A = renderer.geo.A, [sx, sy] = view.pxToSrc(x, y); return [sx / A, sy]; };
function boxMove(x, y) {
  const [u, v] = srcUV(x, y), b = { ...boxDrag.b }, c = (t) => Math.min(1, Math.max(0, t));
  if (boxDrag.corner < 0) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0, du = u - boxDrag.u, dv = v - boxDrag.v;
    b.x0 = Math.min(1 - w, Math.max(0, b.x0 + du)); b.y0 = Math.min(1 - h, Math.max(0, b.y0 + dv)); b.x1 = b.x0 + w; b.y1 = b.y0 + h;
  } else {
    const k = boxDrag.corner;
    if (k === 0 || k === 3) b.x0 = Math.min(c(u), b.x1 - 0.02); else b.x1 = Math.max(c(u), b.x0 + 0.02);
    if (k === 0 || k === 1) b.y0 = Math.min(c(v), b.y1 - 0.02); else b.y1 = Math.max(c(v), b.y0 + 0.02);
  }
  scopeBox = b; onScopeBox(b); overlayDirty = true; dirty = true;
}
function drawScopeBox(g) {
  if (!scopeBox || app.tool !== 'edit') return;
  const c = boxCorners();
  g.lineWidth = 3; g.strokeStyle = '#000a'; g.beginPath(); c.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
  g.lineWidth = 1.5; g.strokeStyle = '#e8c8aa'; g.stroke();
  g.fillStyle = '#e8c8aa'; for (const [x, y] of c) g.fillRect(x - 4, y - 4, 8, 8);
}

export const setTool = (t) => { tool = t; canvas.style.cursor = t?.cursor || ''; overlayDirty = true; dirty = true; };
export const redrawOverlay = () => { overlayDirty = true; dirty = true; };
export const invalidateAll = () => { dirty = true; editDirty = true; geoDirty = true; overlayDirty = true; };

// ---------- geometry ----------
function updateGeo() {
  const it = curItem(), L = app.loaded;
  if (!it || !L) return;
  const A = L.width / L.height;
  const g = makeGeo(it.crop, A, app.tool === 'crop');
  renderer.setGeometry(g);
  renderer.clampView();
  geoDirty = false;
}
export const geo = () => renderer.geo;

// ---------- coordinate helpers (css px relative to the canvas) ----------
const cssSize = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
view.cssSize = cssSize;
view.outToPx = (u, v) => { const [x, y] = renderer.outToCanvas(u, v); const s = cssSize(); return [x * s.w, y * s.h]; };
view.pxToOut = (x, y) => { const s = cssSize(); return renderer.canvasToOut(x / s.w, y / s.h); };
view.srcToPx = (sx, sy) => { const [u, v] = renderer.geo.srcToOut(sx, sy); return view.outToPx(u, v); };
view.pxToSrc = (x, y) => { const [u, v] = view.pxToOut(x, y); return renderer.geo.outToSrc(u, v); };
/** css px per source height unit at the current zoom */
view.pxPerUnit = () => { const a = view.srcToPx(0, 0), b = view.srcToPx(1, 0); return Math.hypot(b[0] - a[0], b[1] - a[1]); };
view.renderer = () => renderer;
view.cssToLocal = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    // zoomed in: keep the photo exactly as big and in the same place on screen (only the visible window changes)
    let keep = null;
    if (renderer.geo && app.loaded && renderer.view.zoom > 1.01 && canvas.width > 1) {
      const v = renderer.view, [fx] = renderer.fit();
      keep = { dispW: fx * v.zoom * canvas.width, left: ((1 + v.px) * canvas.width) / 2, top: ((1 - v.py) * canvas.height) / 2 };
    }
    canvas.width = w; canvas.height = h; ov.width = w; ov.height = h;
    if (keep) {
      const v = renderer.view, [fx] = renderer.fit();
      v.zoom = keep.dispW / (fx * w);
      v.px = (2 * keep.left) / w - 1; v.py = 1 - (2 * keep.top) / h;
    }
    dirty = true; editDirty = true; overlayDirty = true;
    if (renderer.geo) renderer.clampView();
  }
}

// ---------- image ----------
export function setImage(img) {
  renderer.setImage(img.width, img.height, img.half, img.fullW, img.fullH);
  renderer.invalidateBefore();
  geoDirty = true; dirty = true; editDirty = true; overlayDirty = true;
  resize();
}
export function resetView() { renderer.view = { zoom: 1, px: 0, py: 0 }; renderer.clampView(); dirty = true; overlayDirty = true; }

// ---------- render loop ----------
function frame(now) {
  const it = curItem();
  if (dirty && app.loaded && it && !glLost) {
    if (geoDirty) updateGeo();
    {   // spot removal: re-patch the working copy whenever the spots change
      const L = app.loaded, sig = spotSig(it.spots);
      if (L.spotSig !== sig) { L.spotSig = sig; renderer.updateSource(patchedHalf(L.img.half, L.img.width, L.img.height, it.spots)); editDirty = true; }
    }
    const st = renderState(it);
    if (st.p.lut && renderer.lutId !== st.p.lut) ensureLut(st.p.lut);
    let overlayIdx = -1;
    const ovId = app.maskOverlayId || it.selectedMask;
    if (app.tool === 'mask' && ovId && (app.showMaskOverlay || app.maskOverlayTemp)) overlayIdx = st.masks.findIndex((m) => m.id === ovId);
    const edit = editDirty;
    renderer.maskView = app.maskView;
    stats.render = renderer.draw(st, { bypass: app.bypass, editChanged: edit, measure: true, split: app.split, overlay: overlayIdx });
    dirty = false; editDirty = false;
    stats.frames++;
    updateZoomLabel();
    if (edit) scheduleReadback();
  }
  if (overlayDirty && app.loaded) { drawOverlay(); overlayDirty = false; }
  if (now - stats.t > 1000) { stats.fps = Math.round((stats.frames * 1000) / (now - stats.t)); stats.frames = 0; stats.t = now; updateHud(); }
  requestAnimationFrame(frame);
}

function scheduleReadback() {
  if (rbTimer) return;
  rbTimer = setTimeout(() => {
    rbTimer = 0; rbLast = performance.now();
    const px = renderer.readSmall();
    if (px) onReadback(px);
  }, Math.max(0, 90 - (performance.now() - rbLast)));
}
export const readbackNow = () => { const px = renderer.readSmall(); if (px) onReadback(px); return px; };

export function updateHud() {
  const L = app.loaded;
  if (!app.showHud || !L) { hud.classList.remove('show'); return; }
  const i = L.info;
  hud.classList.add('show');
  hud.textContent = `${i.kind} ${i.camera}\n${i.source} → proxy ${L.width}×${L.height}\ndecode ${i.decodeMs | 0} ms · render ${stats.render.toFixed(1)} ms · ${stats.fps} fps`;
}
export function updateZoomLabel() {
  if (!app.loaded || !renderer.geo) return;
  $('zlabel').textContent = Math.round((renderer.view.zoom / renderer.zoom100()) * 100) + '%';
}

// ---------- overlay ----------
function drawOverlay() {
  const g = ov.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, ov.width, ov.height);
  const dpr = ov.width / Math.max(1, canvas.clientWidth);
  g.scale(dpr, dpr);
  if (!renderer.geo) return;
  tool?.drawOverlay?.(g, view);
  drawScopeBox(g);
  if (app.split != null) {
    const s = cssSize(), x = app.split * s.w;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s.h); g.stroke();
    g.fillStyle = '#000b'; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, s.h / 2, 13, 0, 7); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x - 4, s.h / 2 - 5); g.lineTo(x - 9, s.h / 2); g.lineTo(x - 4, s.h / 2 + 5); g.fill();
    g.beginPath(); g.moveTo(x + 4, s.h / 2 - 5); g.lineTo(x + 9, s.h / 2); g.lineTo(x + 4, s.h / 2 + 5); g.fill();
    g.font = '11px -apple-system, system-ui, sans-serif'; g.fillStyle = '#fffd';
    g.fillText('Before', Math.max(8, x - 52), 18); g.fillText('After', Math.min(s.w - 36, x + 10), 18);
  }
}

// ---------- zoom / pan ----------
const ndc = (e) => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
};
export function zoomAt(nx, ny, factor) {
  if (!app.loaded || !renderer.geo) return;
  const v = renderer.view, z0 = v.zoom;
  v.zoom = z0 * factor; renderer.clampView();
  const k = v.zoom / z0;
  v.px = nx - (nx - v.px) * k; v.py = ny - (ny - v.py) * k;
  renderer.clampView(); dirty = true; overlayDirty = true;
}
export const zoomTo = (target, nx = 0, ny = 0) => zoomAt(nx, ny, target / renderer.view.zoom);
export const zoomFit = () => zoomTo(1);
export const zoom100 = () => zoomTo(Math.max(renderer.zoom100(), 1));
export const zoomToggle = () => (renderer.view.zoom > 1.01 ? zoomFit() : zoom100());

{
  const ptrs = new Map();
  let lastPointerType = 'mouse';
  let pinch = null, g0 = 1, useGesture = false, toolDrag = false, splitDrag = false, spaceDown = false;
  // touch: press and hold the photo to see the original, release to go back to the edited version
  let holdTimer = 0, holdOn = false, holdX = 0, holdY = 0;
  let tapC = null;          // a touch / click that could still turn out to be a tap
  let swipe = null;         // phone: a one-finger drag on a photo that fits the screen follows the finger, then goes to the next / previous photo (src/main.js)
  const holdEnd = () => { clearTimeout(holdTimer); holdTimer = 0; if (holdOn) { holdOn = false; app.bypass = false; $('view').classList.remove('holding'); invalidateAll(); } };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) { spaceDown = true; } });
  addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

  canvas.addEventListener('wheel', (e) => {
    if (!app.loaded) return;
    e.preventDefault();
    const [nx, ny] = ndc(e);
    zoomAt(nx, ny, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0025)));
  }, { passive: false });
  // Safari (macOS) reports trackpad pinch as gesture events; touch devices use the pointer path
  canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); useGesture = ptrs.size < 2; g0 = renderer.view.zoom; });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!useGesture || !app.loaded) return;
    const [nx, ny] = ndc(e);
    zoomAt(nx, ny, (g0 * e.scale) / renderer.view.zoom);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!app.loaded || !renderer.geo) return;
    const [x, y] = view.cssToLocal(e);
    lastPointerType = e.pointerType;
    // the first finger of a new touch: any pointer still listed is stale (iOS can drop one without pointerup / pointercancel,
    // which left one-finger drags pinch-zooming until a reload)
    if (e.isPrimary) { ptrs.clear(); pinch = null; }
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    if (ptrs.size === 2) {
      holdEnd(); tapC = null;
      if (swipe?.active) bus.emit('swipe-end', { dx: 0, v: 0 });
      swipe = null;
      if (toolDrag) { tool?.pointerCancel?.(); toolDrag = false; }
      const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); return;
    }
    if (wbPicking) { cancelWb(); pickWb(x, y); ptrs.delete(e.pointerId); return; }
    if (app.split != null && Math.abs(x - app.split * canvas.clientWidth) < 16) { splitDrag = true; return; }
    const bh = !spaceDown && boxHit(x, y, e.pointerType !== 'mouse');
    if (bh) { const [u, v] = srcUV(x, y); boxDrag = { ...bh, u, v, b: { ...scopeBox } }; return; }
    if (!spaceDown && tool?.pointerDown?.(e, x, y, view)) { toolDrag = true; return; }
    if (ptrs.size === 1) tapC = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    if (ptrs.size === 1) swipe = e.pointerType === 'touch' && renderer.view.zoom <= 1.01 ? { id: e.pointerId, x: e.clientX, y: e.clientY, active: false, pts: [[performance.now(), e.clientX]] } : null; else swipe = null;
    if (e.pointerType !== 'mouse' && ptrs.size === 1) {
      holdX = e.clientX; holdY = e.clientY;
      holdTimer = setTimeout(() => { holdTimer = 0; holdOn = true; app.bypass = true; $('view').classList.add('holding'); try { navigator.vibrate?.(8); } catch {} invalidateAll(); }, 380);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = view.cssToLocal(e);
    if (!ptrs.has(e.pointerId)) {
      if (wbPicking) return;
      if (app.split != null) canvas.style.cursor = Math.abs(x - app.split * canvas.clientWidth) < 16 ? 'ew-resize' : (tool?.cursor || '');
      tool?.hover?.(e, x, y, view);
      return;
    }
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (tapC && tapC.id === e.pointerId && Math.hypot(e.clientX - tapC.x, e.clientY - tapC.y) > 8) tapC.moved = true;
    if (holdOn) return;                                          // holding: no panning
    if (swipe && swipe.id === e.pointerId && !toolDrag && !splitDrag && ptrs.size === 1 && app.tool === 'edit') {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      if (!swipe.active && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) { swipe.active = true; clearTimeout(holdTimer); holdTimer = 0; tapC = null; }
      if (swipe.active) {
        swipe.pts.push([performance.now(), e.clientX]); if (swipe.pts.length > 6) swipe.pts.shift();
        bus.emit('swipe-move', dx); return;
      }
    }
    if (holdTimer && Math.hypot(e.clientX - holdX, e.clientY - holdY) > 10) { clearTimeout(holdTimer); holdTimer = 0; }
    if (boxDrag) { boxMove(x, y); return; }
    if (splitDrag) { app.split = Math.min(0.98, Math.max(0.02, x / canvas.clientWidth)); dirty = true; overlayDirty = true; return; }
    if (toolDrag) { tool.pointerMove?.(e, x, y, view); return; }
    const r = canvas.getBoundingClientRect();
    if (ptrs.size === 1) {
      renderer.view.px += ((e.clientX - prev[0]) / r.width) * 2;
      renderer.view.py -= ((e.clientY - prev[1]) / r.height) * 2;
      renderer.clampView(); dirty = true; overlayDirty = true;
    } else if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const [nx, ny] = ndc({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 });
      zoomAt(nx, ny, d / pinch); pinch = d;
    }
  });
  const up = (e) => {
    const wasHold = holdOn;
    holdEnd();
    const [x, y] = view.cssToLocal(e);
    if (tapC && tapC.id === e.pointerId && !tapC.moved && !wasHold && !toolDrag && !splitDrag && ptrs.size === 1 && performance.now() - tapC.t < 450) tool?.tap?.(e, x, y, view);
    if (tapC && tapC.id === e.pointerId) tapC = null;
    if (swipe?.active && swipe.id === e.pointerId) {
      const [t0, x0] = swipe.pts[0], [t1, x1] = swipe.pts[swipe.pts.length - 1];
      bus.emit('swipe-end', { dx: e.type === 'pointerup' ? e.clientX - swipe.x : 0, v: t1 > t0 ? (x1 - x0) / (t1 - t0) : 0 });      // v in px per ms
    }
    if (swipe && swipe.id === e.pointerId) swipe = null;
    if (toolDrag && ptrs.size === 1) { tool.pointerUp?.(e, x, y, view); toolDrag = false; }
    splitDrag = false; boxDrag = null;
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', (e) => { if (ptrs.has(e.pointerId)) up(e); });   // capture lost with no pointerup
  canvas.addEventListener('dblclick', (e) => {
    if (!app.loaded || tool?.blocksDoubleClick || lastPointerType !== 'mouse') return;       // no double-tap zoom on touch screens
    const [nx, ny] = ndc(e);
    zoomTo(renderer.view.zoom > 1.01 ? 1 : Math.max(renderer.zoom100(), 1), nx, ny);
  });
}

// ---------- white balance picker ----------
bus.on('wb-pick', () => { wbPicking = true; canvas.style.cursor = WB_CURSOR; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelWb(); });
function pickWb(x, y) {
  const it = curItem(), img = app.loaded?.img;
  if (!it || !img) return;
  const [sx, sy] = view.pxToSrc(x, y);
  const A = img.width / img.height;
  const rgb = samplePatch(img, Math.min(1, Math.max(0, sx / A)), Math.min(1, Math.max(0, sy)), 3);
  const wb = app.loaded?.info?.wb;
  if (wb) Object.assign(it.params, kelvinFromNeutral(wb, rgb)); else Object.assign(it.params, wbFromLinear(rgb));
  bus.emit('sync-ui');
  changed({ edit: true });
  commit('White balance');
}
