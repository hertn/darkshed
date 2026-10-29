// Masking tool. A mask = components (linear / radial / brush / luminance range / colour range) combined with
// add / subtract / intersect, plus local adjustments and local detail.
import { app, curItem, changed, commit, bus } from '../app.js';
import { MASK_ADJ, MASK_DETAIL, MAX_MASKS, MAX_BRUSH_MASKS, MAX_COMPS, newMask, newComp, uid } from '../params.js';
import { slider } from './slider.js';
import { icon } from './icons.js';
import { redrawOverlay } from '../viewport.js';
import { toast, menu } from './overlays.js';
import { samplePatch } from '../analyze.js';
import { lsGet, lsSet } from '../store.js';

const HIT = 11;
const NAMES = { linear: 'Linear gradient', radial: 'Radial gradient', brush: 'Brush', lum: 'Luminance range', color: 'Color range' };
const ICONS = { linear: 'linear', radial: 'radial', brush: 'brush', lum: 'lum', color: 'invert' };
const OPS = [['add', 'Add'], ['sub', 'Subtract'], ['int', 'Intersect']];
const brushCfg = { size: +lsGet('brushSize', 30), feather: +lsGet('brushFeather', 60), flow: +lsGet('brushFlow', 100), erase: false };
const GEOM = new Set(['linear', 'radial', 'brush']);
const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function createMaskPanel() {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'mask';
  el.innerHTML = '<div class="pane-title">Masking</div><div class="pane-sub">Adjust just part of the photo. Combine shapes and ranges inside one mask.</div>';

  const A = () => { const L = app.loaded; return L ? L.width / L.height : 1; };
  let creating = null;              // { type, op, target: 'new' | 'add' } while waiting for a drag / click on the photo
  let sampling = null;              // 'lum' | 'color' while the eyedropper is armed
  let drag = null;
  let cursorPos = null, nudgeT = 0, previewUntil = 0;
  const flashPreview = () => { previewUntil = Date.now() + 1100; redrawOverlay(); setTimeout(redrawOverlay, 1150); };
  const maskOf = () => { const it = curItem(); return it?.masks.find((m) => m.id === it.selectedMask) || null; };
  const compOf = () => { const m = maskOf(), it = curItem(); if (!m) return null; return m.comps.find((c) => c.id === it.selectedComp) || m.comps[0]; };
  const unitPx = (view) => { const a = view.srcToPx(0, 0), b = view.srcToPx(1, 0); return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  const px = (view, sx, sy) => view.srcToPx(sx, sy);

  // ================= panel =================
  const label = (t) => { const d = document.createElement('div'); d.className = 'group-title'; d.textContent = t; return d; };
  const create = document.createElement('div'); create.className = 'mask-create'; create.style.gridTemplateColumns = 'repeat(5, 1fr)';
  const createBtns = {};
  for (const [type, lbl] of [['linear', 'Linear'], ['radial', 'Radial'], ['brush', 'Brush'], ['lum', 'Lum'], ['color', 'Color']]) {
    const b = document.createElement('button'); b.style.padding = '10px 2px 7px'; b.title = NAMES[type];
    b.innerHTML = icon(ICONS[type], 21) + `<span>${lbl}</span>`;
    b.onclick = () => startCreate({ type, op: 'add', target: 'new' });
    createBtns[type] = b; create.append(b);
  }
  el.append(create);
  const list = document.createElement('div'); list.className = 'mask-list'; el.append(list);
  const opts = document.createElement('div'); el.append(opts);

  // --- components
  const compTitle = label('Components');
  const compList = document.createElement('div'); compList.className = 'mask-list';
  const addRow = document.createElement('div'); addRow.className = 'btn-row';
  const addBtn = document.createElement('button'); addBtn.className = 'btn small'; addBtn.innerHTML = icon('plus', 15) + 'Add / subtract / intersect';
  addBtn.onclick = () => {
    const m = maskOf(); if (!m) return;
    const mk = (op) => ['linear', 'radial', 'brush', 'lum', 'color'].map((t) => ({ label: `${NAMES[t]}`, onClick: () => startCreate({ type: t, op, target: 'add' }) }));
    const sect = (name, op) => [{ label: name.toUpperCase(), disabled: true }, ...mk(op)];
    menu([...sect('Add', 'add'), 'sep', ...sect('Subtract', 'sub'), 'sep', ...sect('Intersect', 'int')], addBtn);
  };
  addRow.append(addBtn);

  // --- selected component options
  const compBox = document.createElement('div');
  const ovRow = document.createElement('label'); ovRow.className = 'check';
  const ovCb = document.createElement('input'); ovCb.type = 'checkbox'; ovCb.checked = false;
  ovRow.append(ovCb, 'Show overlay (O)');
  app.showMaskOverlay = false; app.maskOverlayTemp = false; app.maskOverlayId = null;
  ovCb.onchange = () => { app.showMaskOverlay = ovCb.checked; changed({ edit: false }); };
  const tempOverlay = (on, id = null) => { app.maskOverlayTemp = on; app.maskOverlayId = on ? id : null; changed({ edit: false }); };
  const invRow = document.createElement('label'); invRow.className = 'check';
  const invCb = document.createElement('input'); invCb.type = 'checkbox';
  invRow.append(invCb, 'Invert this component');
  invCb.onchange = () => { const c = compOf(); if (!c) return; c.invert = invCb.checked; changed({ edit: true }); commit('Invert'); };

  const featherS = slider({ label: 'Feather', min: 0, max: 100, step: 1, def: 50, value: 50, format: (v) => String(Math.round(v)),
    onInput: (v) => { const c = compOf(); if (!c) return; c.feather = v / 100; changed({ edit: true }); redrawOverlay(); }, onChange: () => commit('Mask feather') });

  const brushBox = document.createElement('div');
  const bSize = slider({ label: 'Size', min: 1, max: 100, step: 1, def: 30, value: brushCfg.size, format: (v) => String(Math.round(v)), onInput: (v) => { brushCfg.size = v; lsSet('brushSize', v); flashPreview(); } });
  const bFeather = slider({ label: 'Feather', min: 0, max: 100, step: 1, def: 60, value: brushCfg.feather, format: (v) => String(Math.round(v)), onInput: (v) => { brushCfg.feather = v; lsSet('brushFeather', v); flashPreview(); } });
  const bFlow = slider({ label: 'Flow', min: 1, max: 100, step: 1, def: 100, value: brushCfg.flow, format: (v) => String(Math.round(v)), onInput: (v) => { brushCfg.flow = v; lsSet('brushFlow', v); } });
  const eraseRow = document.createElement('label'); eraseRow.className = 'check';
  const eraseCb = document.createElement('input'); eraseCb.type = 'checkbox';
  eraseRow.append(eraseCb, 'Erase (hold Alt)');
  eraseCb.onchange = () => { brushCfg.erase = eraseCb.checked; };
  const clearBtn = document.createElement('button'); clearBtn.className = 'btn small ghost'; clearBtn.textContent = 'Clear strokes';
  clearBtn.onclick = () => { const c = compOf(); if (!c) return; c.strokes = []; c.rev++; changed({ edit: true }); commit('Clear brush'); redrawOverlay(); };
  const clearRow = document.createElement('div'); clearRow.className = 'btn-row'; clearRow.append(clearBtn);
  brushBox.append(bSize.el, bFeather.el, bFlow.el, eraseRow, clearRow);

  // range controls
  const rangeBox = document.createElement('div');
  const rs = {};
  const mkRange = (key, lbl, min, max, fmt, apply, extra = {}) => {
    const w = slider({ label: lbl, min, max, step: 1, def: extra.def ?? 0, value: 0, format: fmt || ((v) => String(Math.round(v))), track: undefined,
      onInput: (v) => { const c = compOf(); if (!c?.range) return; apply(c.range, v); changed({ edit: true }); }, onChange: () => commit('Range') });
    rs[key] = w; rangeBox.append(w.el); return w;
  };
  const lumBox = document.createElement('div'), colBox = document.createElement('div');
  rangeBox.append(lumBox, colBox);
  const sampleBtn = document.createElement('button'); sampleBtn.className = 'btn small'; sampleBtn.innerHTML = icon('pipette', 15) + 'Sample from photo';
  sampleBtn.onclick = () => { const c = compOf(); if (!c) return; sampling = c.type; document.getElementById('cv').style.cursor = 'crosshair'; toast('Click the photo to sample'); };
  const sampleRow = document.createElement('div'); sampleRow.className = 'btn-row'; sampleRow.append(sampleBtn);
  const mkR = (host, key, lbl, min, max, apply, def = 0, track) => {
    const w = slider({ label: lbl, min, max, step: 1, def, value: def, format: (v) => String(Math.round(v)), track,
      onInput: (v) => { const c = compOf(); if (!c?.range) return; apply(c.range, v); changed({ edit: true }); }, onChange: () => commit('Range') });
    rs[key] = w; host.append(w.el); return w;
  };
  mkR(lumBox, 'lo', 'Minimum', 0, 100, (r, v) => { r.lo = Math.min(v / 100, r.hi - 0.01); });
  mkR(lumBox, 'hi', 'Maximum', 0, 100, (r, v) => { r.hi = Math.max(v / 100, r.lo + 0.01); }, 100);
  mkR(lumBox, 'lsm', 'Smoothness', 0, 100, (r, v) => { r.smooth = v / 100 * 0.5; }, 30);
  const hueW = mkR(colBox, 'hue', 'Hue', 0, 360, (r, v) => { r.hue = v; }, 0);
  hueW.el.querySelector('input.lr').style.setProperty('--tr', 'linear-gradient(to right, red, #ff0, #0f0, #0ff, #00f, #f0f, red)');
  mkR(colBox, 'range', 'Range', 1, 100, (r, v) => { r.range = v / 100; }, 30);
  mkR(colBox, 'sat', 'Min saturation', 0, 100, (r, v) => { r.satMin = v / 100; }, 12);
  mkR(colBox, 'csm', 'Smoothness', 0, 100, (r, v) => { r.smooth = v / 100; }, 30);
  void mkRange;
  compBox.append(ovRow, invRow, featherS.el, brushBox, rangeBox, sampleRow);

  // --- adjustments
  const adjTitle = label('Adjustments');
  const adjBox = document.createElement('div');
  const adjSliders = {};
  for (const [key, lbl, min, max, step] of MASK_ADJ) {
    const w = slider({
      label: lbl, min, max, step, def: 0, value: 0, track: key === 'temp' || key === 'tint' ? key : undefined,
      onInput: (v) => { const m = maskOf(); if (!m) return; m.adj[key] = v; changed({ edit: true }); refreshList(); },
      onChange: () => commit('Mask adjustment'),
    });
    adjSliders[key] = w; adjBox.append(w.el);
  }
  const detTitle = label('Detail');
  const detBox = document.createElement('div');
  const detSliders = {};
  for (const [key, lbl, min, max, step] of MASK_DETAIL) {
    const w = slider({
      label: lbl, min, max, step, def: 0, value: 0,
      onInput: (v) => { const m = maskOf(); if (!m) return; m.detail[key] = v; changed({ edit: true }); refreshList(); },
      onChange: () => commit('Mask detail'),
    });
    detSliders[key] = w; detBox.append(w.el);
  }
  const delRow = document.createElement('div'); delRow.className = 'btn-row';
  const delBtn = document.createElement('button'); delBtn.className = 'btn small danger ghost'; delBtn.innerHTML = icon('trash', 15) + 'Delete mask';
  delBtn.onclick = () => deleteMask();
  const dupBtn = document.createElement('button'); dupBtn.className = 'btn small ghost'; dupBtn.innerHTML = icon('copy', 15) + 'Duplicate';
  dupBtn.onclick = () => duplicateMask();
  delRow.append(dupBtn, delBtn);
  opts.append(compTitle, compList, addRow, compBox, adjTitle, adjBox, detTitle, detBox, delRow);

  // ================= state -> UI =================
  const maskLabel = (m) => m.name || NAMES[m.comps[0].type];
  function refreshList() {
    const it = curItem();
    list.textContent = '';
    if (!it) return;
    it.masks.forEach((m) => {
      const row = document.createElement('div'); row.className = 'mask-item' + (m.id === it.selectedMask ? ' on' : '');
      const ic = document.createElement('span'); ic.innerHTML = icon(ICONS[m.comps[0].type], 18);
      const nm = document.createElement('span'); nm.className = 'mi-name'; nm.textContent = maskLabel(m) + (m.comps.length > 1 ? `  (${m.comps.length})` : '');
      const eye = document.createElement('button'); eye.className = 'ib'; eye.title = m.enabled === false ? 'Show mask' : 'Hide mask';
      eye.innerHTML = icon(m.enabled === false ? 'eyeOff' : 'eye', 15);
      eye.onclick = (e) => { e.stopPropagation(); m.enabled = m.enabled === false; changed({ edit: true }); refreshList(); commit('Toggle mask'); };
      row.append(ic, nm, eye);
      row.onclick = () => select(m.id);
      row.onmouseenter = () => tempOverlay(true, m.id);
      row.onmouseleave = () => tempOverlay(false);
      list.append(row);
    });
  }
  function refreshComps() {
    const m = maskOf(), it = curItem();
    compList.textContent = '';
    if (!m) return;
    const cur = compOf();
    m.comps.forEach((c, j) => {
      const row = document.createElement('div'); row.className = 'mask-item' + (c === cur ? ' on' : '');
      const ic = document.createElement('span'); ic.innerHTML = icon(ICONS[c.type], 17);
      const nm = document.createElement('span'); nm.className = 'mi-name'; nm.textContent = NAMES[c.type];
      row.append(ic, nm);
      if (j > 0) {
        const sel = document.createElement('select'); sel.style.cssText = 'padding:2px 4px;font-size:11px;flex:none';
        for (const [v, t] of OPS) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
        sel.value = c.op; sel.onclick = (e) => e.stopPropagation();
        sel.onchange = () => { c.op = sel.value; changed({ edit: true }); commit('Component mode'); };
        row.append(sel);
        const x = document.createElement('button'); x.className = 'ib'; x.title = 'Remove component'; x.innerHTML = icon('close', 14);
        x.onclick = (e) => { e.stopPropagation(); m.comps = m.comps.filter((k) => k !== c); it.selectedComp = m.comps[0].id; sync(); changed({ edit: true }); commit('Remove component'); };
        row.append(x);
      } else { const b = document.createElement('span'); b.style.cssText = 'font-size:11px;color:var(--mut)'; b.textContent = 'Base'; row.append(b); }
      row.onclick = () => { it.selectedComp = c.id; sync(); };
      compList.append(row);
    });
    addBtn.disabled = m.comps.length >= MAX_COMPS;
  }
  function refreshOptions() {
    const m = maskOf(), c = compOf();
    opts.style.display = m ? '' : 'none';
    for (const [t, b] of Object.entries(createBtns)) b.classList.toggle('on', !!creating && creating.target === 'new' && creating.type === t || sampling === t && false);
    if (!m || !c) return;
    refreshComps();
    invCb.checked = !!c.invert;
    featherS.el.style.display = c.type === 'radial' ? '' : 'none';
    if (c.type === 'radial') featherS.set(Math.round(c.feather * 100));
    brushBox.style.display = c.type === 'brush' ? '' : 'none';
    eraseCb.checked = brushCfg.erase;
    rangeBox.style.display = c.type === 'lum' || c.type === 'color' ? '' : 'none';
    sampleRow.style.display = c.type === 'lum' || c.type === 'color' ? '' : 'none';
    lumBox.style.display = c.type === 'lum' ? '' : 'none'; colBox.style.display = c.type === 'color' ? '' : 'none';
    if (c.type === 'lum') { rs.lo.set(Math.round(c.range.lo * 100)); rs.hi.set(Math.round(c.range.hi * 100)); rs.lsm.set(Math.round(c.range.smooth * 200)); }
    if (c.type === 'color') { rs.hue.set(Math.round(c.range.hue)); rs.range.set(Math.round(c.range.range * 100)); rs.sat.set(Math.round(c.range.satMin * 100)); rs.csm.set(Math.round(c.range.smooth * 100)); }
    for (const [k, w] of Object.entries(adjSliders)) w.set(m.adj[k] || 0);
    for (const [k, w] of Object.entries(detSliders)) w.set(m.detail[k] || 0);
  }
  function select(id) {
    const it = curItem(); if (!it) return;
    it.selectedMask = id; creating = null; sampling = null;
    const m = maskOf(); it.selectedComp = m?.comps[0].id || null;
    refreshList(); refreshOptions(); changed({ edit: true }); redrawOverlay();
  }
  function sync() { refreshList(); refreshOptions(); redrawOverlay(); }

  const brushCount = (it) => it.masks.reduce((n, m) => n + m.comps.filter((c) => c.type === 'brush').length, 0);
  const nameFor = (it, type) => `${NAMES[type]} ${it.masks.filter((x) => x.comps[0].type === type).length + 1}`;

  function startCreate(spec) {
    const it = curItem(); if (!it) return;
    sampling = null;
    if (spec.target === 'new' && it.masks.length >= MAX_MASKS) { toast(`Up to ${MAX_MASKS} masks per photo`); return; }
    if (spec.target === 'add' && maskOf().comps.length >= MAX_COMPS) { toast(`Up to ${MAX_COMPS} components per mask`); return; }
    if (spec.type === 'brush' && brushCount(it) >= MAX_BRUSH_MASKS) { toast(`Up to ${MAX_BRUSH_MASKS} brushes per photo`); return; }
    if (spec.type === 'brush' || spec.type === 'lum') return addComponent(spec, {});
    if (spec.type === 'color') {                         // needs a colour: sample one from the photo
      creating = spec; sampling = null; refreshOptions(); document.getElementById('cv').style.cursor = 'crosshair';
      toast('Click a colour in the photo to select it'); return;
    }
    creating = spec; if (spec.target === 'new') it.selectedMask = null;
    refreshOptions(); refreshList(); redrawOverlay();
    toast(spec.type === 'linear' ? 'Drag from where the effect is strongest. Drag the centre to move it.' : 'Drag out from the centre. Drag inside to move it.');
  }
  /** Create a new mask with this component, or add the component to the selected mask. */
  function addComponent(spec, geo, range) {
    const it = curItem(); if (!it) return null;
    const c = newComp(spec.type, geo); c.op = spec.op;
    if (range) Object.assign(c.range, range);
    if (spec.target === 'new') {
      const m = newMask(spec.type, geo); m.comps = [c]; c.op = 'add'; m.name = nameFor(it, spec.type);
      it.masks.push(m); it.selectedMask = m.id;
    } else maskOf().comps.push(c);
    it.selectedComp = c.id; creating = null;
    sync(); changed({ edit: true }); commit(`Add ${NAMES[spec.type].toLowerCase()}`);
    if (spec.type === 'brush') toast('Paint on the photo');
    return c;
  }
  function duplicateMask() {
    const it = curItem(), m = maskOf(); if (!it || !m) return;
    if (it.masks.length >= MAX_MASKS) { toast(`Up to ${MAX_MASKS} masks per photo`); return; }
    const brushes = m.comps.filter((c) => c.type === 'brush').length;
    if (brushes && brushCount(it) + brushes > MAX_BRUSH_MASKS) { toast(`Up to ${MAX_BRUSH_MASKS} brushes per photo`); return; }
    const d = structuredClone(m); d.id = uid('m'); d.name = `${maskLabel(m)} copy`;
    for (const c of d.comps) { c.id = uid('c'); c.rev = 0; }
    it.masks.splice(it.masks.indexOf(m) + 1, 0, d); it.selectedMask = d.id; it.selectedComp = d.comps[0].id;
    sync(); changed({ edit: true, brush: brushes > 0 }); commit('Duplicate mask');
  }
  function deleteMask() {
    const it = curItem(), m = maskOf(); if (!it || !m) return;
    it.masks = it.masks.filter((x) => x !== m); it.selectedMask = it.masks.at(-1)?.id || null; it.selectedComp = null;
    const m2 = maskOf(); it.selectedComp = m2?.comps[0].id || null;
    sync(); changed({ edit: true }); commit('Delete mask');
  }

  // ================= geometry =================
  const defaultLinear = (sx, sy) => ({ x0: sx, y0: Math.max(0.05, sy - 0.2), x1: sx, y1: Math.min(0.95, sy + 0.2) });
  const defaultRadial = (sx, sy) => ({ cx: sx, cy: sy, rx: 0.25, ry: 0.18, angle: 0 });
  const snapshot = (m) => m.comps.map((c) => (c.type === 'brush' ? c.strokes.map((st) => st.pts.map((p) => [p[0], p[1]])) : GEOM.has(c.type) ? JSON.parse(JSON.stringify(c.geo)) : null));
  function translate(m, snap, dx, dy) {
    m.comps.forEach((c, i) => {
      const o = snap[i];
      if (c.type === 'linear') Object.assign(c.geo, { x0: o.x0 + dx, y0: o.y0 + dy, x1: o.x1 + dx, y1: o.y1 + dy });
      else if (c.type === 'radial') { c.geo.cx = o.cx + dx; c.geo.cy = o.cy + dy; }
      else if (c.type === 'brush') { c.strokes.forEach((st, k) => { st.pts = o[k].map((p) => [p[0] + dx, p[1] + dy]); }); c.rev++; }
    });
  }
  function pinPos(view, m) {
    for (const c of m.comps) {
      if (c.type === 'linear') return px(view, c.geo.x0, c.geo.y0);
      if (c.type === 'radial') return px(view, c.geo.cx, c.geo.cy);
      if (c.type === 'brush' && c.strokes[0]) return px(view, c.strokes[0].pts[0][0], c.strokes[0].pts[0][1]);
    }
    return null;
  }
  function radialHandles(view, g) {
    const ca = Math.cos(g.angle || 0), sa = Math.sin(g.angle || 0);
    const pt = (dx, dy) => [g.cx + ca * dx - sa * dy, g.cy + sa * dx + ca * dy];
    const out = {};
    for (const [k, p] of Object.entries({ e: pt(g.rx, 0), w: pt(-g.rx, 0), s: pt(0, g.ry), n: pt(0, -g.ry) })) out[k] = px(view, p[0], p[1]);
    const c = px(view, g.cx, g.cy), e = out.e, dx = e[0] - c[0], dy = e[1] - c[1], len = Math.hypot(dx, dy) || 1;
    out.rot = [e[0] + (dx / len) * 26, e[1] + (dy / len) * 26]; out.c = c;
    return out;
  }
  const brushRadiusUnits = () => (brushCfg.size / 100) * 0.12;

  function hitTest(view, x, y) {
    const it = curItem(), m = maskOf(), c = compOf(); if (!it) return null;
    const near = (p) => Math.hypot(x - p[0], y - p[1]) <= HIT;
    if (c && c.type === 'linear') {
      const g = c.geo, p0 = px(view, g.x0, g.y0), p1 = px(view, g.x1, g.y1);
      if (near(p0)) return { kind: 'l0' };
      if (near(p1)) return { kind: 'l1' };
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      if (near(mid)) return { kind: 'lmove' };
      const d = [p1[0] - p0[0], p1[1] - p0[1]], L = Math.hypot(d[0], d[1]) || 1;
      const t = ((x - p0[0]) * d[0] + (y - p0[1]) * d[1]) / (L * L), along = ((x - p0[0]) * d[0] + (y - p0[1]) * d[1]) / L;
      if ((t > 0 && t < 1) || Math.abs(along) < 7 || Math.abs(along - L) < 7) return { kind: 'lmove' };
    }
    if (c && c.type === 'radial') {
      const h = radialHandles(view, c.geo), g = c.geo;
      for (const k of ['rot', 'e', 'w', 'n', 's']) if (near(h[k])) return { kind: 'r' + k };
      if (near(h.c)) return { kind: 'rmove' };
      const [sx, sy] = view.pxToSrc(x, y), ca = Math.cos(g.angle || 0), sa = Math.sin(g.angle || 0);
      const qx = (sx - g.cx) * ca + (sy - g.cy) * sa, qy = -(sx - g.cx) * sa + (sy - g.cy) * ca;
      if ((qx / g.rx) ** 2 + (qy / g.ry) ** 2 <= 1) return { kind: 'rmove' };
    }
    for (const o of it.masks) {
      const p = pinPos(view, o);
      if (!p || !near(p)) continue;
      if (o.id !== it.selectedMask) return { kind: 'pin', id: o.id };
      if (m && c && c.type === 'brush') return { kind: 'pinmove' };
    }
    return null;
  }

  function sampleAt(sx, sy, kind, comp) {
    const L = app.loaded; if (!L) return;
    const [r, g, b] = samplePatch(L.img, Math.min(1, Math.max(0, sx / A())), Math.min(1, Math.max(0, sy)), 2).map(enc);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 1e-5) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = ((h * 60) + 360) % 360; }
    const sat = mx > 0 ? d / mx : 0;
    return kind === 'lum' ? { lo: Math.max(0, l - 0.12), hi: Math.min(1, l + 0.12), smooth: 0.12 } : { hue: h, range: 0.22, satMin: Math.max(0.05, sat * 0.4), smooth: 0.3 };
  }

  const impl = {
    cursor: 'crosshair', blocksDoubleClick: true,
    pointerDown(e, x, y, view) {
      const it = curItem(); if (!it) return false;
      const [sx, sy] = view.pxToSrc(x, y);
      if (sampling) {                                    // eyedropper for an existing luminance / colour component
        const c = compOf(), kind = sampling; sampling = null;
        if (c) { Object.assign(c.range, sampleAt(sx, sy, kind, c)); refreshOptions(); changed({ edit: true }); commit('Sample range'); }
        document.getElementById('cv').style.cursor = 'crosshair';
        return true;
      }
      if (creating && creating.type === 'color') {       // new colour-range mask / component from a clicked colour
        const spec = creating; creating = null;
        addComponent(spec, {}, sampleAt(sx, sy, 'color'));
        return true;
      }
      if (creating) {
        const spec = creating; creating = null;
        const geo = spec.type === 'linear' ? { x0: sx, y0: sy, x1: sx, y1: sy } : { cx: sx, cy: sy, rx: 0.001, ry: 0.001, angle: 0 };
        const c = addComponentQuiet(spec, geo);
        drag = { kind: 'create', type: spec.type, sx, sy, comp: c, moved: false };
        tempOverlay(true);
        return true;
      }
      const h = hitTest(view, x, y);
      if (h?.kind === 'pin') { select(h.id); drag = { kind: 'pinmove', sx, sy, snap: snapshot(maskOf()) }; tempOverlay(true); return true; }
      if (h) { const c = compOf(); drag = { ...h, sx, sy, snap: snapshot(maskOf()), orig: c && GEOM.has(c.type) && c.type !== 'brush' ? JSON.parse(JSON.stringify(c.geo)) : null }; tempOverlay(true); return true; }
      const c = compOf();
      if (c?.type === 'brush') {
        const stroke = { size: brushRadiusUnits() * 2, feather: brushCfg.feather / 100, flow: brushCfg.flow / 100, erase: brushCfg.erase || e.altKey, pts: [[sx, sy]] };
        c.strokes.push(stroke); c.rev++;
        drag = { kind: 'paint', stroke, comp: c };
        tempOverlay(true); changed({ edit: true });
        return true;
      }
      return false;
    },
    pointerMove(e, x, y, view) {
      if (!drag) return;
      const [sx, sy] = view.pxToSrc(x, y);
      cursorPos = [x, y];
      const m = maskOf(), c = compOf();
      if (drag.kind === 'create') {
        const k = drag.comp;
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 0.01) drag.moved = true;
        if (drag.type === 'linear') k.geo = { x0: drag.sx, y0: drag.sy, x1: sx, y1: sy };
        else k.geo = { cx: drag.sx, cy: drag.sy, rx: Math.max(0.02, Math.abs(sx - drag.sx)), ry: Math.max(0.02, Math.abs(sy - drag.sy)), angle: 0 };
      } else if (drag.kind === 'paint') {
        const last = drag.stroke.pts.at(-1);
        if (Math.hypot(sx - last[0], sy - last[1]) > brushRadiusUnits() * 0.1) { drag.stroke.pts.push([sx, sy]); drag.comp.rev++; } else return redrawOverlay();
      } else if (m && drag.kind === 'pinmove') translate(m, drag.snap, sx - drag.sx, sy - drag.sy);
      else if (c) {
        const g = c.geo, k = drag.kind, o = drag.orig;
        if (k === 'l0') { g.x0 = sx; g.y0 = sy; }
        else if (k === 'l1') { g.x1 = sx; g.y1 = sy; }
        else if (k === 'lmove' || k === 'rmove') translate(m, drag.snap, sx - drag.sx, sy - drag.sy);
        else if (k === 'rrot') g.angle = Math.atan2(sy - g.cy, sx - g.cx);
        else if (['re', 'rw', 'rn', 'rs'].includes(k)) {
          const ca = Math.cos(g.angle || 0), sa = Math.sin(g.angle || 0);
          const qx = (sx - g.cx) * ca + (sy - g.cy) * sa, qy = -(sx - g.cx) * sa + (sy - g.cy) * ca;
          if (k === 're' || k === 'rw') g.rx = Math.max(0.01, Math.abs(qx)); else g.ry = Math.max(0.01, Math.abs(qy));
        }
        void o;
      }
      changed({ edit: true }); redrawOverlay();
    },
    pointerUp() {
      if (!drag) return;
      const d = drag; drag = null;
      tempOverlay(false);
      if (d.kind === 'create') {
        const c = d.comp;
        if (c.type === 'linear' && (!d.moved || Math.hypot(c.geo.x1 - c.geo.x0, c.geo.y1 - c.geo.y0) < 0.02)) c.geo = defaultLinear(d.sx, d.sy);
        else if (c.type === 'radial' && !d.moved) c.geo = defaultRadial(d.sx, d.sy);
        sync(); changed({ edit: true }); commit(`Add ${NAMES[c.type].toLowerCase()}`);
      } else if (d.kind === 'paint') { changed({ edit: true }); commit('Brush'); }
      else commit('Adjust mask');
      redrawOverlay();
    },
    pointerCancel() { drag = null; tempOverlay(false); },
    hover(e, x, y, view) {
      cursorPos = [x, y];
      const c = compOf();
      if (c?.type === 'brush' && !creating) redrawOverlay();
      const h = hitTest(view, x, y);
      document.getElementById('cv').style.cursor = creating || sampling ? 'crosshair' : h ? (h.kind === 'pin' ? 'pointer' : 'move') : (c?.type === 'brush' ? 'none' : 'crosshair');
    },
    drawOverlay(g, view) {
      const it = curItem(); if (!it) return;
      const s = view.cssSize();
      if (Date.now() < previewUntil && compOf()?.type === 'brush') {      // brush size preview while the slider moves
        const r = Math.max(2, brushRadiusUnits() * unitPx(view)), cx = s.w / 2, cy = s.h / 2;
        g.save(); g.fillStyle = 'rgba(255,255,255,.14)'; g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.stroke();
        g.setLineDash([4, 4]); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(cx, cy, r * Math.max(0.05, 1 - brushCfg.feather / 100), 0, 7); g.stroke();
        g.restore();
      }
      for (const m of it.masks) {
        const isSel = m.id === it.selectedMask;
        if (!isSel) {
          const p = pinPos(view, m);
          if (p) { g.fillStyle = '#000a'; g.strokeStyle = m.enabled === false ? '#888' : '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(p[0], p[1], 6, 0, 7); g.fill(); g.stroke(); }
          continue;
        }
        // all geometric components of the selected mask are shown, the selected one with handles
        for (const c of m.comps) {
          const active = c === compOf();
          g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1.2; g.globalAlpha = active ? 1 : 0.45;
          if (c.type === 'linear') {
            const p0 = px(view, c.geo.x0, c.geo.y0), p1 = px(view, c.geo.x1, c.geo.y1);
            const d = [p1[0] - p0[0], p1[1] - p0[1]], L = Math.hypot(d[0], d[1]) || 1, n = [-d[1] / L, d[0] / L], R = Math.max(s.w, s.h) * 2;
            const line = (p, dash) => { g.setLineDash(dash); g.beginPath(); g.moveTo(p[0] - n[0] * R, p[1] - n[1] * R); g.lineTo(p[0] + n[0] * R, p[1] + n[1] * R); g.stroke(); g.setLineDash([]); };
            line(p0, []); line(p1, [6, 5]);
            g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.stroke();
            if (active) {
              for (const p of [p0, p1]) { g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.beginPath(); g.arc(p[0], p[1], 6, 0, 7); g.fill(); g.stroke(); }
              const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
              g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(mid[0], mid[1], 8, 0, 7); g.stroke();
              g.beginPath(); g.moveTo(mid[0] - 4, mid[1]); g.lineTo(mid[0] + 4, mid[1]); g.moveTo(mid[0], mid[1] - 4); g.lineTo(mid[0], mid[1] + 4); g.stroke();
            }
          } else if (c.type === 'radial') {
            const gm = c.geo, steps = 72;
            const ring = (k, dash) => {
              g.setLineDash(dash); g.beginPath();
              for (let i = 0; i <= steps; i++) {
                const a = (i / steps) * Math.PI * 2, ca = Math.cos(gm.angle || 0), sa = Math.sin(gm.angle || 0);
                const lx = Math.cos(a) * gm.rx * k, ly = Math.sin(a) * gm.ry * k;
                const p = px(view, gm.cx + ca * lx - sa * ly, gm.cy + sa * lx + ca * ly);
                i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]);
              }
              g.stroke(); g.setLineDash([]);
            };
            ring(1, []); g.globalAlpha *= 0.55; ring(Math.max(0.05, 1 - c.feather), [5, 5]); g.globalAlpha = active ? 1 : 0.45;
            if (active) {
              const h = radialHandles(view, gm);
              g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(h.e[0], h.e[1]); g.lineTo(h.rot[0], h.rot[1]); g.stroke();
              g.strokeStyle = '#000'; g.fillStyle = '#fff';
              for (const k of ['e', 'w', 'n', 's']) { g.beginPath(); g.rect(h[k][0] - 4, h[k][1] - 4, 8, 8); g.fill(); g.stroke(); }
              g.beginPath(); g.arc(h.rot[0], h.rot[1], 5, 0, 7); g.fill(); g.stroke();
              g.beginPath(); g.arc(h.c[0], h.c[1], 6, 0, 7); g.fill(); g.stroke();
            }
          } else if (c.type === 'brush' && active && !creating && cursorPos) {
            const r = brushRadiusUnits() * unitPx(view);
            g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.beginPath(); g.arc(cursorPos[0], cursorPos[1], r, 0, 7); g.stroke();
            g.strokeStyle = '#fff6'; g.beginPath(); g.arc(cursorPos[0], cursorPos[1], r * Math.max(0.05, 1 - brushCfg.feather / 100), 0, 7); g.stroke();
          }
          g.globalAlpha = 1;
        }
        const p = pinPos(view, m);
        if (p) { g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.2; g.beginPath(); g.arc(p[0], p[1], 7, 0, 7); g.fill(); g.stroke(); }
      }
    },
    keydown(e) {
      const m = maskOf();
      if (e.key === 'Escape') {
        if (creating || sampling) { creating = null; sampling = null; refreshOptions(); redrawOverlay(); return true; }
        return false;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (m) { e.preventDefault(); deleteMask(); return true; } }
      const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (ARROWS[e.key] && m) {
        const step = e.shiftKey ? 0.02 : 0.004, [ax, ay] = ARROWS[e.key];
        translate(m, snapshot(m), ax * step, ay * step);
        changed({ edit: true }); redrawOverlay(); clearTimeout(nudgeT); nudgeT = setTimeout(() => commit('Move mask'), 400);
        return true;
      }
      if (e.key === 'o' || e.key === 'O') { ovCb.checked = !ovCb.checked; ovCb.onchange(); return true; }
      if (e.key === '[') { bSize.set(Math.max(1, brushCfg.size - 5)); brushCfg.size = bSize.get(); flashPreview(); return true; }
      if (e.key === ']') { bSize.set(Math.min(100, brushCfg.size + 5)); brushCfg.size = bSize.get(); flashPreview(); return true; }
      return false;
    },
  };
  /** Like addComponent but without refreshing / committing, because a drag follows. */
  function addComponentQuiet(spec, geo) {
    const it = curItem();
    const c = newComp(spec.type, geo); c.op = spec.op;
    if (spec.target === 'new') {
      const m = newMask(spec.type, geo); m.comps = [c]; c.op = 'add'; m.name = nameFor(it, spec.type);
      it.masks.push(m); it.selectedMask = m.id;
    } else maskOf().comps.push(c);
    it.selectedComp = c.id;
    refreshOptions(); refreshList();
    return c;
  }

  bus.on('select', () => { creating = null; sampling = null; const it = curItem(); if (it && !it.selectedComp && maskOf()) it.selectedComp = maskOf().comps[0].id; sync(); });
  bus.on('restored', () => { const it = curItem(); if (it && !it.masks.some((m) => m.id === it.selectedMask)) it.selectedMask = null; if (it && maskOf() && !maskOf().comps.some((c) => c.id === it.selectedComp)) it.selectedComp = maskOf().comps[0].id; sync(); });
  bus.on('masks-changed', sync);

  return { el, impl, onEnter() { sync(); changed({ edit: true }); }, onLeave() { creating = null; sampling = null; } };
}
