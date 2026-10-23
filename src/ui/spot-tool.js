// Healing tool. Two ways to work:
//   Spot:  tap a blemish; a circle is removed using a matching nearby area.
//   Brush: paint over what you want gone; the whole stroke is healed (or cloned) from an automatically chosen matching area.
// Taps create spots only on release, and a second finger cancels a stroke, so pinch-zoom and panning always work.
import { app, curItem, changed, commit, bus } from '../app.js';
import { newSpot, newStroke, bestSource, accessHalf } from '../spots.js';
import { slider } from './slider.js';
import { icon } from './icons.js';
import { redrawOverlay } from '../viewport.js';
import { lsGet, lsSet } from '../store.js';

const cfg = { type: lsGet('spotType', 'spot'), mode: lsGet('spotMode', 'heal'), size: +lsGet('spotSize', 30), feather: +lsGet('spotFeather', 50), opacity: +lsGet('spotOpacity', 100) };
const unitsFromSize = (s) => 0.004 + (s / 100) * 0.08;               // radius in height units
const sizeFromUnits = (r) => Math.round(Math.min(100, Math.max(1, ((r - 0.004) / 0.08) * 100)));
const segDist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0; return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };
const polyDist = (px, py, pts) => { if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]); let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])); return d; };

export function createSpotPanel() {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'spots';
  el.innerHTML = '<div class="pane-title">Healing</div><div class="pane-sub"></div>';
  const sub = el.querySelector('.pane-sub');

  const A = () => { const L = app.loaded; return L ? L.width / L.height : 1; };
  let sel = null, drag = null, previewUntil = 0, painting = null;
  const flashPreview = () => { previewUntil = Date.now() + 1100; redrawOverlay(); setTimeout(redrawOverlay, 1150); };
  const spots = () => curItem()?.spots || [];
  const cur = () => spots().find((s) => s.id === sel) || null;
  const isStroke = (s) => s?.kind === 'stroke';

  // ----- type: spot / brush -----
  const typeSeg = document.createElement('div'); typeSeg.className = 'seg'; typeSeg.style.margin = '4px 16px 8px';
  typeSeg.innerHTML = '<button data-v="spot">Spot</button><button data-v="brush">Brush</button>';
  typeSeg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cfg.type = b.dataset.v; lsSet('spotType', cfg.type); paint(); };
  // ----- heal / clone -----
  const seg = document.createElement('div'); seg.className = 'seg'; seg.style.margin = '0 16px 8px';
  seg.innerHTML = '<button data-v="heal">Heal</button><button data-v="clone">Clone</button>';
  seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cfg.mode = b.dataset.v; lsSet('spotMode', cfg.mode); const s = cur(); if (s) { s.mode = cfg.mode; changed({ edit: true }); commit('Heal mode'); } paint(); };
  el.append(typeSeg, seg);

  const mk = (label, key, min, max, def, apply) => slider({
    label, min, max, step: 1, def, value: cfg[key], format: (v) => String(Math.round(v)),
    onInput: (v) => { cfg[key] = v; lsSet('spot' + key[0].toUpperCase() + key.slice(1), v); const s = cur(); if (s) { apply(s, v); changed({ edit: true }); } if (key !== 'opacity') flashPreview(); else redrawOverlay(); },
    onChange: () => { if (cur()) commit('Healing'); },
  });
  const sSize = mk('Size', 'size', 1, 100, 30, (s, v) => { s.r = unitsFromSize(v); });
  const sFeather = mk('Feather', 'feather', 0, 100, 50, (s, v) => { s.feather = v / 100; });
  const sOpacity = mk('Opacity', 'opacity', 1, 100, 100, (s, v) => { s.opacity = v / 100; });
  el.append(sSize.el, sFeather.el, sOpacity.el);

  const show = document.createElement('label'); show.className = 'check';
  const showCb = document.createElement('input'); showCb.type = 'checkbox'; showCb.checked = true;
  show.append(showCb, 'Show healing marks (H)');
  showCb.onchange = redrawOverlay;
  const row = document.createElement('div'); row.className = 'btn-row';
  const del = document.createElement('button'); del.className = 'btn small ghost danger'; del.innerHTML = icon('trash', 15) + 'Delete';
  const delAll = document.createElement('button'); delAll.className = 'btn small ghost'; delAll.textContent = 'Clear all';
  del.onclick = () => removeSel(); delAll.onclick = () => { const it = curItem(); if (!it || !it.spots.length) return; it.spots = []; sel = null; changed({ edit: true }); commit('Clear healing'); paint(); };
  row.append(del, delAll);
  const count = document.createElement('p'); count.className = 'hint';
  el.append(show, row, count);

  function paint() {
    for (const b of typeSeg.children) b.classList.toggle('on', b.dataset.v === cfg.type);
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === (cur()?.mode || cfg.mode));
    sub.textContent = cfg.type === 'brush'
      ? 'Paint over what you want removed. The app picks a matching area to copy from; drag the blue area to change it. Use two fingers to zoom and pan.'
      : 'Tap a spot to remove it. Drag its circle to move it, drag the dashed circle to choose where it samples from.';
    const s = cur();
    if (s) { sSize.set(sizeFromUnits(s.r)); sFeather.set(Math.round(s.feather * 100)); sOpacity.set(Math.round(s.opacity * 100)); }
    else { sSize.set(cfg.size); sFeather.set(cfg.feather); sOpacity.set(cfg.opacity); }
    del.disabled = !s;
    count.textContent = `${spots().length} healing mark${spots().length === 1 ? '' : 's'} on this photo`;
    redrawOverlay();
  }
  function removeSel() { const it = curItem(), s = cur(); if (!it || !s) return; it.spots = it.spots.filter((x) => x !== s); sel = null; changed({ edit: true }); commit('Remove healing'); paint(); }

  // ----- geometry in screen px -----
  const unit = (view) => view.pxPerUnit();
  const pos = (view, x, y) => view.srcToPx(x, y);
  const px = (view, pts) => pts.map(([x, y]) => pos(view, x, y));
  const shifted = (s) => s.pts.map(([x, y]) => [x + s.off[0], y + s.off[1]]);
  function hit(view, x, y) {
    const u = unit(view), list = spots(), s0 = cur();
    if (s0 && !isStroke(s0)) {
      const c = pos(view, s0.x, s0.y), r = s0.r * u, sc = pos(view, s0.sx, s0.sy);
      if (Math.hypot(x - (c[0] + r), y - c[1]) < 11) return { kind: 'resize', s: s0 };
      if (Math.hypot(x - sc[0], y - sc[1]) <= Math.max(r, 10)) return { kind: 'src', s: s0 };
    }
    if (s0 && isStroke(s0) && polyDist(x, y, px(view, shifted(s0))) <= Math.max(s0.r * u, 12)) return { kind: 'src', s: s0 };
    for (const s of [...list].reverse()) {
      if (isStroke(s)) { if (polyDist(x, y, px(view, s.pts)) <= Math.max(s.r * u, 12)) return { kind: 'dest', s }; continue; }
      const c = pos(view, s.x, s.y), r = Math.max(s.r * u, 10);
      if (Math.hypot(x - c[0], y - c[1]) <= r + 3) return { kind: 'dest', s };
    }
    return null;
  }
  // auto source from the working image, so the choice works at any zoom
  function pickSource(pts, r) {
    const L = app.loaded;
    if (!L) return [0.1, 0];
    return bestSource(L.width, L.height, accessHalf(L.img.half, L.width), pts, r);
  }

  const impl = {
    cursor: 'crosshair', blocksDoubleClick: true,
    pointerDown(e, x, y, view) {
      const it = curItem(); if (!it) return false;
      const h = hit(view, x, y);
      const [sx, sy] = view.pxToSrc(x, y);
      if (h) {
        sel = h.s.id; paint();
        drag = { kind: h.kind, s: h.s, sx, sy, o: isStroke(h.s) ? { pts: h.s.pts.map((p) => p.slice()), off: h.s.off.slice(), r: h.s.r } : { x: h.s.x, y: h.s.y, sx: h.s.sx, sy: h.s.sy, r: h.s.r } };
        return true;
      }
      if (cfg.type === 'brush' && sx >= 0 && sy >= 0 && sx <= A() && sy <= 1) {         // start painting; a second finger cancels it
        painting = { pts: [[sx, sy]] }; drag = { kind: 'paint' }; redrawOverlay();
        return true;
      }
      return false;                                                                      // empty ground: leave it to pan / pinch / tap
    },
    tap(e, x, y, view) {                                                                  // Spot type: a tap on empty ground makes a spot
      const it = curItem(); if (!it || cfg.type !== 'spot') return;
      if (hit(view, x, y)) return;
      const [sx, sy] = view.pxToSrc(x, y);
      if (sx < 0 || sy < 0 || sx > A() || sy > 1) { sel = null; paint(); return; }
      const r = unitsFromSize(cfg.size), [dx, dy] = pickSource([[sx, sy]], r);
      const s = newSpot({ x: sx, y: sy, sx: sx + dx, sy: sy + dy, r, feather: cfg.feather / 100, opacity: cfg.opacity / 100, mode: cfg.mode });
      it.spots.push(s); sel = s.id;
      changed({ edit: true }); commit('Healing spot'); paint();
    },
    pointerMove(e, x, y, view) {
      if (!drag) return;
      const [px0, py0] = view.pxToSrc(x, y);
      if (drag.kind === 'paint') {
        const last = painting.pts.at(-1), r = unitsFromSize(cfg.size);
        if (Math.hypot(px0 - last[0], py0 - last[1]) > r * 0.12) painting.pts.push([px0, py0]);
        redrawOverlay(); return;
      }
      const s = drag.s, o = drag.o, dx = px0 - drag.sx, dy = py0 - drag.sy;
      if (isStroke(s)) {
        if (drag.kind === 'dest') s.pts = o.pts.map(([x0, y0]) => [x0 + dx, y0 + dy]);
        else if (drag.kind === 'src') s.off = [o.off[0] + dx, o.off[1] + dy];
      } else if (drag.kind === 'dest') { s.x = o.x + dx; s.y = o.y + dy; }
      else if (drag.kind === 'src') { s.sx = o.sx + dx; s.sy = o.sy + dy; }
      else if (drag.kind === 'resize') { s.r = Math.max(0.003, Math.min(0.2, Math.hypot(px0 - s.x, py0 - s.y))); sSize.set(sizeFromUnits(s.r)); }
      changed({ edit: true }); redrawOverlay();
    },
    pointerUp() {
      if (!drag) return;
      const d = drag; drag = null;
      const it = curItem();
      if (d.kind === 'paint') {
        const pts = painting.pts; painting = null;
        if (it && pts.length) {
          const r = unitsFromSize(cfg.size), off = pickSource(pts, r);
          const st = newStroke({ pts, r, off, feather: cfg.feather / 100, opacity: cfg.opacity / 100, mode: cfg.mode });
          it.spots.push(st); sel = st.id; changed({ edit: true }); commit('Healing brush'); paint();
        }
        return;
      }
      changed({ edit: true }); commit('Healing'); paint();
    },
    pointerCancel() { drag = null; painting = null; redrawOverlay(); },           // e.g. a second finger arrived: it was a pinch, not a stroke
    hover(e, x, y, view) { const h = hit(view, x, y); document.getElementById('cv').style.cursor = h ? (h.kind === 'resize' ? 'nwse-resize' : 'move') : (cfg.type === 'brush' ? 'none' : 'crosshair'); },
    drawOverlay(g, view) {
      const u = unit(view), sz = view.cssSize();
      if (Date.now() < previewUntil) {                  // show how big the brush is while the slider moves
        const s0 = cur();
        const c = s0 ? (isStroke(s0) ? pos(view, s0.pts[0][0], s0.pts[0][1]) : pos(view, s0.x, s0.y)) : [sz.w / 2, sz.h / 2];
        const r = Math.max(2, (s0 ? s0.r : unitsFromSize(cfg.size)) * u), fe = s0 ? s0.feather : cfg.feather / 100;
        g.save(); g.fillStyle = 'rgba(255,255,255,.14)'; g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(c[0], c[1], r, 0, 7); g.fill(); g.stroke();
        g.setLineDash([4, 4]); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(c[0], c[1], r * Math.max(0.05, 1 - fe), 0, 7); g.stroke();
        g.restore();
      }
      const thick = (pts, r, style) => {                // a painted stroke as a thick rounded line
        if (!pts.length) return;
        g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = style; g.lineWidth = Math.max(4, r * u * 2);
        g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (pts.length === 1) g.lineTo(pts[0][0] + 0.01, pts[0][1]); g.stroke(); g.restore();
      };
      if (painting) thick(px(view, painting.pts), unitsFromSize(cfg.size), 'rgba(255,255,255,.3)');
      if (!showCb.checked) return;
      for (const s of spots()) {
        const isSel = s.id === sel;
        if (isStroke(s)) {
          thick(px(view, s.pts), s.r, isSel ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.14)');
          if (isSel) {
            const sp = px(view, shifted(s)), c = pos(view, s.pts[0][0], s.pts[0][1]);
            thick(sp, s.r, 'rgba(255,175,90,.30)');
            g.save(); g.setLineDash([5, 4]); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(sp[0][0], sp[0][1]); g.stroke(); g.restore();
            g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath(); g.arc(sp[0][0], sp[0][1], 5, 0, 7); g.fill(); g.stroke();
          }
          continue;
        }
        const c = pos(view, s.x, s.y), r = Math.max(s.r * u, 4);
        g.lineWidth = isSel ? 2 : 1.2; g.strokeStyle = isSel ? '#fff' : '#ffffffaa';
        g.beginPath(); g.arc(c[0], c[1], r, 0, 7); g.stroke();
        g.strokeStyle = '#0006'; g.lineWidth = 1; g.beginPath(); g.arc(c[0], c[1], r + 1.5, 0, 7); g.stroke();
        if (!isSel) continue;
        const sc = pos(view, s.sx, s.sy);
        g.setLineDash([5, 4]); g.strokeStyle = '#fff'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(sc[0], sc[1], r, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(sc[0], sc[1]); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1;
        g.beginPath(); g.arc(c[0] + r, c[1], 5, 0, 7); g.fill(); g.stroke();
        g.beginPath(); g.arc(sc[0], sc[1], 3, 0, 7); g.fill();
      }
    },
    keydown(e) {
      if (e.key === 'Delete' || e.key === 'Backspace') { if (cur()) { e.preventDefault(); removeSel(); return true; } }
      if (e.key === 'Escape') { sel = null; paint(); return true; }
      if (e.key === 'h' || e.key === 'H') { showCb.checked = !showCb.checked; redrawOverlay(); return true; }
      if (e.key === 'b' || e.key === 'B') { cfg.type = cfg.type === 'brush' ? 'spot' : 'brush'; lsSet('spotType', cfg.type); paint(); return true; }
      return false;
    },
  };
  bus.on('select', () => { sel = null; paint(); });
  bus.on('restored', () => { if (!cur()) sel = null; paint(); });
  return { el, impl, onEnter() { paint(); }, onLeave() { sel = null; painting = null; } };
}
