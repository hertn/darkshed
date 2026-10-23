// Crop & rotate tool: panel + on-canvas overlay with draggable handles.
import { app, curItem, changed, commit, bus } from '../app.js';
import { defaultCrop, clone } from '../params.js';
import { cropRect, fitInside, moveInside, rectInside, rectForAspect, aspectValue, rotate90, flip, frameHalf, defaultRect } from '../geometry.js';
import { slider } from './slider.js';
import { icon } from './icons.js';
import { redrawOverlay, resetView, geo as getGeo } from '../viewport.js';

const ASPECTS = [
  ['orig', 'As shot'], ['free', 'Free'], ['1:1', '1:1'], ['4:5', '4:5'], ['5:4', '5:4'], ['3:2', '3:2'], ['2:3', '2:3'],
  ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16'],
];
const HIT = 14, MIN = 0.04;

export function createCropPanel({ setToolId }) {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'crop';
  el.innerHTML = '<div class="pane-title">Crop &amp; rotate</div><div class="pane-sub">Drag the handles on the photo to crop. Drag inside to move.</div>';

  const A = () => { const L = app.loaded; return L ? L.width / L.height : 1; };
  let enterSnapshot = null, straightening = false, dragging = null, hoverHandle = null;

  // ----- aspect -----
  const row1 = document.createElement('div'); row1.className = 'field-row';
  const lab = document.createElement('label'); lab.textContent = 'Aspect';
  const sel = document.createElement('select');
  for (const [v, l] of ASPECTS) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.append(o); }
  const swapBtn = document.createElement('button'); swapBtn.className = 'ib'; swapBtn.title = 'Swap orientation (X)'; swapBtn.innerHTML = icon('swap', 18);
  row1.append(lab, sel, swapBtn);
  el.append(row1);

  // ----- rotate / flip -----
  const row2 = document.createElement('div'); row2.className = 'btn-row';
  const mk = (ic, title, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.title = title; b.innerHTML = icon(ic, 17); b.onclick = fn; row2.append(b); return b; };
  mk('rotL', 'Rotate left 90°', () => rot(-1)); mk('rotR', 'Rotate right 90°', () => rot(1));
  mk('flipH', 'Flip horizontal', () => doFlip('h')); mk('flipV', 'Flip vertical', () => doFlip('v'));
  el.append(row2);

  // ----- straighten -----
  const ang = slider({
    label: 'Straighten', min: -45, max: 45, step: 0.1, def: 0, value: 0,
    format: (v) => v.toFixed(1) + '°',
    onInput: (v) => { const it = curItem(); if (!it) return; straightening = true; it.crop.angle = v; refit(it); changed({ geo: true }); redrawOverlay(); },
    onChange: () => { straightening = false; redrawOverlay(); commit('Straighten'); },
  });
  el.append(ang.el);

  const row3 = document.createElement('div'); row3.className = 'btn-row';
  const reset = document.createElement('button'); reset.className = 'btn small ghost'; reset.textContent = 'Reset crop';
  const done = document.createElement('button'); done.className = 'btn small primary'; done.textContent = 'Done';
  row3.append(reset, done); el.append(row3);
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = 'Enter = done · Esc = cancel · X = swap orientation.';
  el.append(hint);

  // ----- helpers -----
  function refit(it) {
    const a = A();
    if (!it.crop.rect) return;
    let r = it.crop.rect;
    if (!rectInside(it.crop, a, r)) {
      r = fitInside(it.crop, a, r);
      if (r.w < MIN) r = fitInside(it.crop, a, { cx: 0, cy: 0, w: r.w || 1, h: r.h || 1 });
      it.crop.rect = r;
    }
  }
  function syncUi() {
    const it = curItem(); if (!it) return;
    sel.value = ASPECTS.some(([v]) => v === it.crop.aspect) ? it.crop.aspect : 'free';
    ang.set(it.crop.angle);
  }
  function rot(dir) {
    const it = curItem(); if (!it) return;
    rotate90(it.crop, dir);
    refit(it); syncUi(); changed({ geo: true }); resetView(); redrawOverlay(); commit('Rotate');
  }
  function doFlip(axis) {
    const it = curItem(); if (!it) return;
    flip(it.crop, axis); refit(it); changed({ geo: true }); redrawOverlay(); commit('Flip');
  }
  function applyAspect(v) {
    const it = curItem(); if (!it) return;
    it.crop.aspect = v;
    const asp = aspectValue(it.crop, A());
    if (asp) it.crop.rect = rectForAspect(it.crop, A(), cropRect(it.crop, A()), asp);
    changed({ geo: true }); redrawOverlay(); commit('Crop aspect');
  }
  function swapOrientation() {
    const it = curItem(); if (!it) return;
    const r = cropRect(it.crop, A());
    let v = it.crop.aspect;
    if (v === 'orig' || v === 'free' || !v.includes(':')) v = `${Math.round(r.h * 100)}:${Math.round(r.w * 100)}`;
    else { const [a, b] = v.split(':'); v = `${b}:${a}`; }
    it.crop.aspect = v; syncUi(); applyAspect(v);
    if (![...sel.options].some((o) => o.value === v)) sel.value = 'free';
  }
  sel.onchange = () => applyAspect(sel.value);
  swapBtn.onclick = swapOrientation;
  reset.onclick = () => {
    const it = curItem(); if (!it) return;
    it.crop = defaultCrop(); syncUi(); changed({ geo: true }); resetView(); redrawOverlay(); commit('Reset crop');
  };
  done.onclick = () => setToolId('edit');

  // ----- overlay geometry (screen px) -----
  function rectPx(view, r) {
    const g = getGeo();   // frame geometry while the crop tool is open
    const p = (ox, oy) => { const [u, v] = g.oToOut(ox, oy); return view.outToPx(u, v); };
    const tl = p(r.cx - r.w / 2, r.cy - r.h / 2), br = p(r.cx + r.w / 2, r.cy + r.h / 2);
    return { x0: tl[0], y0: tl[1], x1: br[0], y1: br[1] };
  }
  function handles(b) {
    const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
    return [
      ['nw', b.x0, b.y0], ['n', mx, b.y0], ['ne', b.x1, b.y0], ['e', b.x1, my],
      ['se', b.x1, b.y1], ['s', mx, b.y1], ['sw', b.x0, b.y1], ['w', b.x0, my],
    ];
  }
  function hit(view, x, y) {
    const it = curItem(); if (!it) return null;
    const b = rectPx(view, cropRect(it.crop, A()));
    for (const [id, hx, hy] of handles(b)) if (Math.hypot(x - hx, y - hy) <= HIT) return id;
    if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return 'move';
    return null;
  }
  const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

  // pointer (css px) -> O frame (height units, relative to image centre)
  const toO = (view, x, y) => { const g = getGeo(); const [u, v] = view.pxToOut(x, y); return g.outToO(u, v); };

  function resizeTo(it, id, p, startRect, asp) {
    const L = startRect.cx - startRect.w / 2, R = startRect.cx + startRect.w / 2, T = startRect.cy - startRect.h / 2, B = startRect.cy + startRect.h / 2;
    let l = L, r = R, t = T, b = B;
    if (id.includes('w')) l = Math.min(p[0], R - MIN);
    if (id.includes('e')) r = Math.max(p[0], L + MIN);
    if (id.includes('n')) t = Math.min(p[1], B - MIN);
    if (id.includes('s')) b = Math.max(p[1], T + MIN);
    if (asp) {
      const corner = id.length === 2;
      if (corner) {
        let w = r - l, h = b - t;
        if (w / asp > h) h = w / asp; else w = h * asp;
        if (id.includes('w')) l = R - w; else r = L + w;
        if (id.includes('n')) t = B - h; else b = T + h;
      } else if (id === 'e' || id === 'w') {
        const h = (r - l) / asp, cy = startRect.cy; t = cy - h / 2; b = cy + h / 2;
      } else {
        const w = (b - t) * asp, cx = startRect.cx; l = cx - w / 2; r = cx + w / 2;
      }
    }
    return { cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t };
  }

  const impl = {
    cursor: 'default',
    blocksDoubleClick: true,
    pointerDown(e, x, y, view) {
      const it = curItem(); if (!it) return false;
      const id = hit(view, x, y);
      if (!id) return false;
      const start = toO(view, x, y);
      dragging = { id, start, rect: { ...cropRect(it.crop, A()) }, last: { ...cropRect(it.crop, A()) } };
      return true;
    },
    pointerMove(e, x, y, view) {
      const it = curItem(); if (!it || !dragging) return;
      const a = A(), p = toO(view, x, y), d = dragging;
      const asp = aspectValue(it.crop, a);
      let cand;
      if (d.id === 'move') cand = moveInside(it.crop, a, d.last, p[0] - d.start[0] - (d.last.cx - d.rect.cx), p[1] - d.start[1] - (d.last.cy - d.rect.cy));
      else {
        cand = resizeTo(it, d.id, p, d.rect, asp);
        if (!rectInside(it.crop, a, cand)) {
          // slide back toward the last valid rect until it fits
          let lo = 0, hi = 1, best = d.last;
          for (let i = 0; i < 14; i++) {
            const t = (lo + hi) / 2;
            const c = { cx: d.last.cx + (cand.cx - d.last.cx) * t, cy: d.last.cy + (cand.cy - d.last.cy) * t, w: d.last.w + (cand.w - d.last.w) * t, h: d.last.h + (cand.h - d.last.h) * t };
            if (rectInside(it.crop, a, c)) { best = c; lo = t; } else hi = t;
          }
          cand = best;
        }
      }
      d.last = cand;
      it.crop.rect = cand;
      if (d.id !== 'move' && (!asp)) it.crop.aspect = 'free';
      sel.value = it.crop.aspect in Object.fromEntries(ASPECTS) ? it.crop.aspect : 'free';
      changed({ geo: false, edit: false }); redrawOverlay();
    },
    pointerUp() { if (dragging) { dragging = null; changed({ geo: true }); commit('Crop'); } },
    pointerCancel() { dragging = null; },
    hover(e, x, y, view) {
      const id = hit(view, x, y);
      if (id !== hoverHandle) { hoverHandle = id; document.getElementById('cv').style.cursor = id ? CURSOR[id] : 'default'; }
    },
    drawOverlay(g, view) {
      const it = curItem(); if (!it) return;
      const r = cropRect(it.crop, A());
      const b = rectPx(view, r);
      const s = view.cssSize();
      // dim outside
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.rect(0, 0, s.w, s.h); g.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.fill('evenodd');
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
      // thirds (or a fine grid while straightening / dragging)
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1;
      const n = straightening ? 8 : 3;
      for (let i = 1; i < n; i++) {
        const x = b.x0 + ((b.x1 - b.x0) * i) / n, y = b.y0 + ((b.y1 - b.y0) * i) / n;
        g.beginPath(); g.moveTo(x, b.y0); g.lineTo(x, b.y1); g.moveTo(b.x0, y); g.lineTo(b.x1, y); g.stroke();
      }
      // handles
      g.fillStyle = '#fff'; g.strokeStyle = '#000a'; g.lineWidth = 1;
      for (const [id, hx, hy] of handles(b)) {
        const corner = id.length === 2;
        g.beginPath();
        if (corner) g.rect(hx - 5, hy - 5, 10, 10); else g.rect(hx - (id === 'n' || id === 's' ? 9 : 3), hy - (id === 'e' || id === 'w' ? 9 : 3), id === 'n' || id === 's' ? 18 : 6, id === 'e' || id === 'w' ? 18 : 6);
        g.fill(); g.stroke();
      }
    },
    keydown(e) {
      if (e.key === 'Enter') { setToolId('edit'); return true; }
      if (e.key === 'Escape') { cancel(); return true; }
      if (e.key === 'x' || e.key === 'X') { swapOrientation(); return true; }
      return false;
    },
  };
  function cancel() {
    const it = curItem();
    if (it && enterSnapshot) { it.crop = clone(enterSnapshot); changed({ geo: true }); }
    setToolId('edit');
  }

  bus.on('select', () => { syncUi(); });
  bus.on('restored', syncUi);

  return {
    el, impl,
    onEnter() {
      const it = curItem(); if (!it) return;
      enterSnapshot = clone(it.crop);
      syncUi(); resetView(); redrawOverlay();
    },
    onLeave() { resetView(); },
  };
}
