import { evalCurve, curveIsIdentity } from './curves-math.js';
import { identityCurves } from './params.js';

const CHANNELS = [['rgb', 'RGB', '#ece7e2'], ['r', 'R', '#ff5a5a'], ['g', 'G', '#4ade80'], ['b', 'B', '#5b9dff']];
const HIT = 14;       // css px grab radius
const MIN_DX = 0.02;  // keep points apart so the spline stays well-behaved

/**
 * Draggable point-curve editor.
 *   host:      element to render into
 *   get():     returns the live curves object { rgb, r, g, b } -> arrays of [x, y] in 0..1
 *   onChange:  called while dragging / after edits
 * Returns { redraw }.
 */
export function createCurveEditor(host, get, onChange, onCommit = () => {}) {
  let ch = 'rgb';
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  const cv = document.createElement('canvas'); cv.className = 'curve';
  host.append(tabs, cv);

  const btns = {};
  for (const [id, label, color] of CHANNELS) {
    const b = document.createElement('button'); b.className = 'tab'; b.textContent = label; b.style.setProperty('--c', color);
    b.onclick = () => { ch = id; redraw(); markTabs(); };
    tabs.append(b); btns[id] = b;
  }
  const markTabs = () => { for (const id in btns) btns[id].classList.toggle('on', id === ch); };
  markTabs();

  const size = () => cv.getBoundingClientRect().width || 240;
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), s = size();
    if (cv.width !== Math.round(s * dpr)) { cv.width = Math.round(s * dpr); cv.height = Math.round(s * dpr); }
  }
  const toPx = (x, y) => [x * cv.width, (1 - y) * cv.height];

  function redraw() {
    for (const id in btns) btns[id].classList.toggle('mod', !curveIsIdentity(get()[id]));
    fit();
    const g = cv.getContext('2d'), W = cv.width, dpr = W / size();
    g.clearRect(0, 0, W, W);
    const fl = cv.classList.contains('float');
    const grabbed = fl && drag >= 0;                 // while a point is held the tint goes so the photo's colours are accurate
    g.fillStyle = fl ? 'rgba(8,8,10,.32)' : '#171514'; if (!grabbed) g.fillRect(0, 0, W, W);
    g.strokeStyle = fl ? 'rgba(255,255,255,.28)' : '#2c2724'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo((W * i) / 4, 0); g.lineTo((W * i) / 4, W); g.moveTo(0, (W * i) / 4); g.lineTo(W, (W * i) / 4); g.stroke();
    }
    g.strokeStyle = fl ? 'rgba(255,255,255,.35)' : '#3d3733'; g.beginPath(); g.moveTo(0, W); g.lineTo(W, 0); g.stroke();
    const curves = get();
    const color = CHANNELS.find((c) => c[0] === ch)[2];
    // faint master underneath when editing a colour channel
    if (ch !== 'rgb') drawCurve(g, curves.rgb, '#55555d', 1.5 * dpr);
    drawCurve(g, curves[ch], color, 2 * dpr);
    g.fillStyle = color;
    for (const [x, y] of curves[ch]) {
      const [px, py] = toPx(x, y);
      g.beginPath(); g.arc(px, py, 5 * dpr, 0, 7); g.fill();
      g.strokeStyle = '#0e0e10'; g.lineWidth = 1.5 * dpr; g.stroke();
    }
  }
  function drawCurve(g, pts, color, lw) {
    g.strokeStyle = color; g.lineWidth = lw; g.beginPath();
    for (let i = 0; i <= 128; i++) {
      const x = i / 128, [px, py] = toPx(x, evalCurve(pts, x));
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.stroke();
  }

  const local = (e) => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, r.width];
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const nearest = (pts, x, y, w) => {
    let best = -1, bd = HIT / w;
    pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  let drag = -1, down = null, lastTap = null;
  cv.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    const [x, y, w] = local(e), pts = get()[ch];
    let i = nearest(pts, x, y, w);
    if (i < 0) {
      const nx = clamp01(x);
      if (pts.some(([px]) => Math.abs(px - nx) < MIN_DX)) return;
      pts.push([nx, clamp01(y)]); pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex(([px]) => px === nx);
      onChange();
    }
    drag = i; try { cv.setPointerCapture(e.pointerId); } catch {} redraw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = local(e), pts = get()[ch], last = pts.length - 1;
    const lo = drag === 0 ? 0 : pts[drag - 1][0] + MIN_DX;
    const hi = drag === last ? 1 : pts[drag + 1][0] - MIN_DX;
    const nx = drag === 0 ? 0 : drag === last ? 1 : Math.min(hi, Math.max(lo, x));
    pts[drag] = [nx, clamp01(y)];
    redraw(); onChange();
  });
  const end = () => { const was = drag >= 0; if (was) onCommit(); drag = -1; if (was) redraw(); };
  // Double click / double tap on a point: an inner point is removed, an end point goes back to its original corner. Detected here
  // because iOS sends no dblclick for touches (and the first press may already have added a point).
  const doubleTap = (e) => {
    const now = performance.now(), d = down; down = null;
    if (e.type !== 'pointerup' || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || now - d.t > 350) { lastTap = null; return false; }
    const prev = lastTap; lastTap = { x: e.clientX, y: e.clientY, t: now };
    if (!prev || now - prev.t > 450 || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 24) return false;
    lastTap = null;
    const [x, y, w] = local(e), pts = get()[ch], i = nearest(pts, x, y, w);
    if (i < 0) return false;
    if (i > 0 && i < pts.length - 1) pts.splice(i, 1);
    else pts[i] = i === 0 ? [0, 0] : [1, 1];
    return true;
  };
  const finish = (e) => { const changed = doubleTap(e); end(); if (changed) { redraw(); onChange(); onCommit(); } };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
  new ResizeObserver(redraw).observe(cv);
  return { redraw, reset() { Object.assign(get(), identityCurves()); redraw(); onChange(); onCommit(); } };
}
