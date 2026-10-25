// The Edit panel: histogram, Auto / B&W, and the Light / Color / Effects / Detail sections.
import { app, curItem, changed, commit, registerSection, bus } from '../app.js';
import { invalidateAll } from '../viewport.js';
import { PARAMS, HSL_PARAMS, GRADE_PARAMS, HSL_BANDS, BAND_HUE, SECTIONS, defaults, identityCurves } from '../params.js';
import { curvesActive } from '../curves-math.js';
import { createCurveEditor } from '../curves.js';
import { createHistogram } from './histogram.js';
import { createGrading } from './grading.js';
import { slider } from './slider.js';
import { icon } from './icons.js';
import { autoTone, autoWb, autoWbRgb } from '../analyze.js';
import { isRaw } from '../decode.js';
import { WB_PRESETS, presetValues, asShotKelvin, tempToKelvin, posToKelvin, kelvinToPos, kelvinFromNeutral, POS_MAX } from '../wb.js';
import { lsGet, lsSet } from '../store.js';
import { isEdited } from '../library.js';
import { defaults as paramDefaults, defaultCrop } from '../params.js';
import { toast } from './overlays.js';

const widgets = {};            // param key -> slider
const sections = {};           // id -> { el, keys, curves, badge, pwr, reset }
const subs = {};               // id -> { el, keys, curves, badge }
const D = defaults();
let soloOn = lsGet('solo', '0') === '1';
let curveEditor = null, histogram = null, bwBtn = null;
let colorMixSel = lsGet('mixSel', 'red');
const mixSliders = {}, checks = {};
let wbSelect = null, resetBtn = null, bwMobile = null;
let grading = null, mixSwatches = {};

const P = () => curItem()?.params;

function setParam(key, v) {
  const it = curItem(); if (!it) return;
  it.params[key] = v;
  changed({ edit: true });
  refresh();
}
const isDef = (k) => { const v = P()?.[k]; return v === undefined || v === D[k]; };
const keysModified = (keys, curves) => keys.some((k) => !isDef(k)) || (curves && P() && curvesActive(P().curves));

function paramSlider(host, row, opts = {}) {
  const [key, label, min, max, step, , , def] = row;
  const w = slider({
    label: opts.label || label, min, max, step, def, value: P()?.[key] ?? def, track: opts.track, color: opts.color,
    onInput: (v) => (opts.set || setParam)(key, v),
    onChange: () => commit(opts.label || label),
  });
  host.append(w.el);
  widgets[key] = w;
  return w;
}

// Sharpening > Masking: hold Alt while dragging (or just drag, on a touch screen) to see what the sharpening reaches, in black and white
function maskViewHook(el) {
  const rng = el.querySelector('input.lr');
  let down = false;
  const set = (on) => { if (app.maskView !== on) { app.maskView = on; invalidateAll(); } };
  const update = (e) => set(down && (e.altKey || e.pointerType === 'touch'));
  rng.addEventListener('pointerdown', (e) => { down = true; update(e); });
  const up = () => { down = false; set(false); };
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  addEventListener('keydown', (e) => { if (down && e.key === 'Alt') set(true); }, true);
  addEventListener('keyup', (e) => { if (e.key === 'Alt') set(false); }, true);
}

// ---------- sections ----------
const sectionsHost = document.createElement('div');
// Solo mode: one section open at a time, and one sub-section open at a time (inside the open section)
function closeOthers(keep) {
  for (const s of Object.values(sections)) if (s.el !== keep && s.el.open) s.el.open = false;
  const keepId = Object.entries(sections).find(([, s]) => s.el === keep)?.[0];
  for (const s of Object.values(subs)) if (s.parent !== keepId && s.el.open && !s.fixed) s.el.open = false;
}
function closeOtherSubs(keep) { for (const s of Object.values(subs)) if (s.el !== keep && s.el.open && !s.fixed) s.el.open = false; }

function makeSection(id, title, { open, keys, curves = false, extraReset }) {
  const el = document.createElement('details'); el.className = 'sec'; el.dataset.sec = id;
  el.open = lsGet('open:' + id, open ? '1' : '0') === '1';
  el.addEventListener('toggle', () => { lsSet('open:' + id, el.open ? '1' : '0'); if (soloOn && el.open && !document.body.classList.contains('m')) closeOthers(el); });
  const sum = document.createElement('summary');
  const ttl = document.createElement('span'); ttl.className = 'ttl'; ttl.textContent = title;
  const badge = document.createElement('i'); badge.className = 'badge'; badge.hidden = true;
  const lead = document.createElement('span'); lead.className = 'lead'; lead.style.display = 'inline-flex'; lead.style.alignItems = 'center'; lead.style.gap = '8px';
  lead.append(ttl, badge);
  const tail = document.createElement('span'); tail.className = 'tail';
  const reset = document.createElement('button'); reset.className = 'mini reset-btn'; reset.textContent = 'Reset'; reset.hidden = true;
  const pwr = document.createElement('button'); pwr.className = 'pwr on'; pwr.title = 'Turn this section on / off';
  tail.append(reset, pwr);
  sum.append(lead, tail);
  const body = document.createElement('div'); body.className = 'body';
  el.append(sum, body);
  registerSection(id, keys, { curves });
  reset.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const it = curItem(); if (!it) return;
    for (const k of keys) it.params[k] = D[k] ?? 0;
    if (curves) it.params.curves = identityCurves();
    extraReset?.(it);
    sync(); changed({ edit: true }); commit(`Reset ${title}`);
  });
  pwr.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const it = curItem(); if (!it) return;
    it.off.has(id) ? it.off.delete(id) : it.off.add(id);
    refresh(); changed({ edit: true }); commit(`${title} ${it.off.has(id) ? 'off' : 'on'}`);
  });
  sections[id] = { el, keys, curves, badge, pwr, reset };
  sectionsHost.append(el);
  return body;
}

function makeSub(parent, id, title, { keys = [], curves = false, open = false, parentId = '', fixed = false }) {
  const el = document.createElement('details'); el.className = 'sub' + (fixed ? ' fixed' : '');
  el.open = fixed || lsGet('open:' + id, open ? '1' : '0') === '1';
  if (fixed) el.addEventListener('toggle', () => { el.open = true; });          // always open: just a heading, not a fold
  else el.addEventListener('toggle', () => { lsSet('open:' + id, el.open ? '1' : '0'); if (soloOn && el.open && !document.body.classList.contains('m')) closeOtherSubs(el); });
  const sum = document.createElement('summary');
  if (fixed) sum.addEventListener('click', (e) => e.preventDefault());
  const ttl = document.createElement('span'); ttl.className = 'ttl'; ttl.textContent = title;
  const badge = document.createElement('i'); badge.className = 'badge'; badge.hidden = true;
  const lead = document.createElement('span'); lead.style.display = 'inline-flex'; lead.style.alignItems = 'center'; lead.style.gap = '8px';
  lead.append(ttl, badge);
  sum.append(lead);
  const body = document.createElement('div'); body.className = 'body';
  el.append(sum, body); parent.append(el);
  subs[id] = { el, keys, curves, badge, parent: parentId, fixed };
  return body;
}

/** Badges, power switches, tab dots. Cheap enough to call on every slider tick. */
export function refresh() {
  const it = curItem();
  for (const [id, s] of Object.entries(sections)) {
    const mod = keysModified(s.keys, s.curves);
    s.badge.hidden = !mod;
    s.reset.hidden = !mod;
    s.el.classList.toggle('off', !!it?.off.has(id));
    s.pwr.classList.toggle('on', !it?.off.has(id));
  }
  for (const s of Object.values(subs)) s.badge.hidden = !keysModified(s.keys, s.curves);
  for (const [b, el] of Object.entries(mixSwatches)) el.classList.toggle('mod', ['hue', 'sat', 'lum'].some((k) => !isDef(`hsl_${b}_${k}`)));
  grading?.mark(isDef);
  bwBtn?.classList.toggle('on', !!P()?.bw);
  bwMobile?.classList.toggle('bw-on', !!P()?.bw);
  syncWb(); syncProfile();
  bus.emit('badges');
}

// ---------- profile dropdown ----------
function syncProfile() {
  const it = curItem();
  if (resetBtn) resetBtn.disabled = !it || !isEdited(it);
}

// RAW photos set white balance in Kelvin (wbK), as a RAW editor does: the Temp slider runs 2000-50000 K in steps of 50. JPEGs keep temp -100..100.
const rawWb = () => { const wb = app.loaded?.info?.wb, it = curItem(); return wb && it && isRaw(it.file) ? wb : null; };
const currentK = (p, wb) => (p.wbK > 0 ? p.wbK : p.temp ? tempToKelvin(wb, p.temp) : asShotKelvin(wb));
function setTemp(key, v) {
  const wb = rawWb(), it = curItem();
  if (!wb || !it) { setParam(key, v); return; }
  const K = posToKelvin(v);
  it.params.wbK = K === asShotKelvin(wb) ? 0 : K; it.params.temp = 0;
  changed({ edit: true }); refresh();
}
function syncTempUnits() {
  const w = widgets.temp, wb = rawWb(), p = P(); if (!w) return;
  if (!wb || !p) { w.setUnits(); return; }
  w.setUnits({
    format: (v) => `${posToKelvin(v)}`, parse: (t) => kelvinToPos(parseFloat(t)), snap: (v) => kelvinToPos(posToKelvin(v)),
    range: [0, POS_MAX], step: 1, def: kelvinToPos(asShotKelvin(wb)),
  });
  w.set(kelvinToPos(currentK(p, wb)));
}

// ---------- white balance dropdown ----------
function wbOptions() {
  const info = app.loaded?.info;
  const opts = [['asshot', info?.wb ? `As Shot (${asShotKelvin(info.wb)} K)` : 'As Shot'], ['auto', 'Auto']];
  if (info?.wb) for (const pr of WB_PRESETS) opts.push([pr.id, `${pr.name} (${pr.K} K)`]);
  opts.push(['custom', 'Custom']);
  return opts;
}
// cache the auto result per photo so this stays cheap while sliders move
function autoValues() {
  const L = app.loaded, wb = rawWb(); if (!L) return null;
  if (wb) { const rgb = (L.img._autoRgb ||= autoWbRgb(L.img)); return rgb ? (L.img._autoRaw ||= kelvinFromNeutral(wb, rgb)) : { wbK: 0, temp: 0, tint: 0 }; }
  return (L.img._autoWb ||= autoWb(L.img));
}
function currentWbChoice() {
  const p = P(), info = app.loaded?.info; if (!p) return 'asshot';
  if (!p.temp && !p.tint && !p.wbK) return 'asshot';
  if (info?.wb) for (const pr of WB_PRESETS) { const v = presetValues(info.wb, pr); if (v.wbK === p.wbK && v.tint === p.tint && !p.temp) return pr.id; }
  const a = autoValues();
  if (a && a.temp === p.temp && a.tint === p.tint && (a.wbK || 0) === (p.wbK || 0)) return 'auto';
  return 'custom';
}
function applyWbChoice(id) {
  const it = curItem(), L = app.loaded; if (!it || !L) return;
  if (id === 'custom') return;
  if (id === 'asshot') { it.params.temp = 0; it.params.tint = 0; it.params.wbK = 0; }
  else if (id === 'auto') Object.assign(it.params, { wbK: 0 }, autoValues());
  else { const pr = WB_PRESETS.find((x) => x.id === id); if (pr && L.info.wb) Object.assign(it.params, presetValues(L.info.wb, pr)); }
  sync(); changed({ edit: true }); commit('White balance');
}
function syncWb() {
  syncTempUnits();
  if (!wbSelect) return;
  const opts = wbOptions(), sig = opts.map((o) => o[1]).join('|');
  if (wbSelect.dataset.sig !== sig) {
    wbSelect.textContent = '';
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; wbSelect.append(o); }
    wbSelect.dataset.sig = sig;
  }
  wbSelect.value = currentWbChoice();
}

/** Pull every control's value from the current photo. */
export function sync() {
  const p = P();
  if (p) {
    for (const [k, w] of Object.entries(widgets)) w.set(p[k] ?? D[k]);
    for (const [k, c] of Object.entries(checks)) c.checked = !!p[k];
    syncMix(); syncGrade(); syncWb();
  }
  curveEditor?.redraw();
  refresh();
}

// ---------- colour mix (HSL) ----------
const hslCss = (kind, h) => {
  const hue = (d) => ((h + d) % 360 + 360) % 360;
  if (kind === 'hue') return `linear-gradient(to right, hsl(${hue(-34)} 85% 52%), hsl(${hue(0)} 85% 52%), hsl(${hue(34)} 85% 52%))`;
  if (kind === 'sat') return `linear-gradient(to right, hsl(${h} 6% 52%), hsl(${h} 95% 50%))`;
  return `linear-gradient(to right, hsl(${h} 70% 10%), hsl(${h} 85% 50%), hsl(${h} 80% 94%))`;
};
function syncMix() {
  const p = P(); if (!p) return;
  for (const [kind, w] of Object.entries(mixSliders)) w.setTrack(hslCss(kind, BAND_HUE[colorMixSel]));
  for (const [kind, w] of Object.entries(mixSliders)) w.set(p[`hsl_${colorMixSel}_${kind}`] ?? 0);
  for (const [b, el] of Object.entries(mixSwatches)) el.classList.toggle('on', b === colorMixSel);
}

// ---------- colour grading ----------
function syncGrade() { grading?.sync(); }

// ---------- build ----------
export function createEditPanel() {
  const el = document.createElement('div'); el.className = 'pane show'; el.dataset.pane = 'edit';

  // histogram + Auto / B&W
  const head = document.createElement('div'); head.className = 'edit-head';     // stays put while the sections scroll
  const hw = document.createElement('div'); hw.className = 'hist-wrap';
  const hc = document.createElement('canvas'); hc.className = 'hist';
  // desktop: the histogram folds away like a section (on phones it floats over the photo and the header is hidden)
  const hh = document.createElement('button'); hh.className = 'hist-head'; hh.type = 'button';
  hh.innerHTML = '<span class="ttl">Histogram</span>';
  const setHistOpen = (on) => { hw.classList.toggle('closed', !on); hh.setAttribute('aria-expanded', on ? 'true' : 'false'); lsSet('histOpen', on ? '1' : '0'); };
  hh.onclick = () => setHistOpen(hw.classList.contains('closed'));
  setHistOpen(lsGet('histOpen', '1') === '1');
  hw.append(hh, hc);
  head.append(hw);
  histogram = createHistogram(hc);
  const row = document.createElement('div'); row.className = 'ph-row'; row.style.padding = '2px 12px 10px'; row.style.alignItems = 'center';
  const autoBtn = document.createElement('button'); autoBtn.className = 'btn small'; autoBtn.innerHTML = icon('auto', 15) + 'Auto';
  const doAuto = () => {
    const it = curItem(), img = app.loaded?.img; if (!it || !img) return;
    Object.assign(it.params, autoTone(img));
    sync(); changed({ edit: true }); commit('Auto tone');
  };
  autoBtn.onclick = doAuto;
  bus.on('cmd', (c) => { if (c === 'auto') doAuto(); });
  bwBtn = document.createElement('button'); bwBtn.className = 'btn small'; bwBtn.innerHTML = icon('bw', 15) + 'B&W';
  bwBtn.onclick = () => {
    const it = curItem(); if (!it) return;
    it.params.bw = it.params.bw ? 0 : 1;
    refresh(); changed({ edit: true }); commit(it.params.bw ? 'Black & white' : 'Colour');
  };
  resetBtn = document.createElement('button'); resetBtn.className = 'btn small ghost'; resetBtn.style.marginLeft = 'auto';
  resetBtn.innerHTML = icon('reset', 15) + 'Reset'; resetBtn.title = 'Reset all edits to the original photo (undo with Ctrl/Cmd+Z)';
  resetBtn.onclick = () => {
    const it = curItem(); if (!it || !isEdited(it)) return;
    it.params = paramDefaults(); it.off = new Set(); it.masks = []; it.spots = []; it.selectedMask = null; it.crop = defaultCrop();
    sync(); changed({ edit: true, geo: true }); commit('Reset to original');
    bus.emit('masks-changed');
    toast('Reset to original. Undo brings your edits back.');
  };
  row.append(autoBtn, bwBtn, resetBtn);
  head.append(row);
  el.append(head);
  el.append(sectionsHost);

  const lightKeys = PARAMS.filter((p) => p[5] === 'light').map((p) => p[0]);
  const colorParams = PARAMS.filter((p) => p[5] === 'color');
  const colorKeys = ['wbK', ...colorParams.map((p) => p[0]), 'bw'];
  const effectsKeys = PARAMS.filter((p) => p[5] === 'effects').map((p) => p[0]);
  const detailKeys = PARAMS.filter((p) => p[5] === 'detail').map((p) => p[0]);
  const open = Object.fromEntries(SECTIONS.map(([id, , o]) => [id, o]));

  // ----- Light -----
  {
    const body = makeSection('light', 'Light', { open: open.light, keys: lightKeys });
    PARAMS.filter((p) => p[5] === 'light').forEach((row) => paramSlider(body, row));
  }

  // ----- Curves -----
  {
    const body = makeSection('curves', 'Curves', { open: open.curves, keys: [], curves: true });
    curveEditor = createCurveEditor(body, () => P()?.curves || identityCurves(), () => { changed({ edit: true }); refresh(); }, () => commit('Tone curves'));
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Click to add a point, drag to move, double-click a point to remove it.';
    body.append(hint);
  }

  // ----- Color -----
  {
    const body = makeSection('color', 'Color', { open: open.color, keys: colorKeys, extraReset: (it) => { it.params.bw = 0; } });
    // black & white on phones: a button at the top left of the Color panel
    {
      const sum = sections.color.el.querySelector('summary');
      const bwM = document.createElement('button'); bwM.className = 'mini m-only bw-btn'; bwM.title = 'Black & white';
      bwM.innerHTML = icon('bw', 16) + '<span>B&W</span>';
      bwM.onclick = (e) => { e.preventDefault(); e.stopPropagation(); bwBtn.click(); };
      sum.prepend(bwM); bwMobile = bwM;       // far left of the header; HSL and Grading sit on the right (added in mobile.js)
    }
    // white balance: preset dropdown + eyedropper (presets for RAW only, like Lightroom)
    const wbRow = document.createElement('div'); wbRow.className = 'field-row'; wbRow.style.paddingBottom = '2px';
    const wbLab = document.createElement('label'); wbLab.textContent = 'WB';
    wbSelect = document.createElement('select');
    const pick = document.createElement('button'); pick.className = 'ib'; pick.title = 'White balance picker: click a neutral grey / white area'; pick.innerHTML = icon('pipette', 19);
    pick.onclick = () => bus.emit('wb-pick');
    wbRow.append(wbLab, wbSelect, pick);
    body.append(wbRow);
    wbSelect.onchange = () => applyWbChoice(wbSelect.value);
    colorParams.forEach((row) => paramSlider(body, row, { track: ['temp', 'tint', 'vibrance', 'saturation'].includes(row[0]) ? row[0] : undefined, set: row[0] === 'temp' ? setTemp : undefined }));
  }

  // ----- HSL (its own section, like Lightroom's Color Mixer) -----
  {
    const mb = makeSection('hsl', 'HSL', { open: open.hsl, keys: HSL_PARAMS.map((p) => p[0]) });
    const sw = document.createElement('div'); sw.className = 'swatches';
    for (const [b, label, color] of HSL_BANDS) {
      const s = document.createElement('button'); s.className = 'sw'; s.style.background = color; s.title = label;
      s.onclick = () => { colorMixSel = b; lsSet('mixSel', b); syncMix(); };
      mixSwatches[b] = s; sw.append(s);
    }
    mb.append(sw);
    for (const [kind, label] of [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']]) {
      const w = slider({
        label, min: -100, max: 100, step: 1, def: 0, value: 0,
        onInput: (v) => setParam(`hsl_${colorMixSel}_${kind}`, v), onChange: () => commit('HSL'),
      });
      mixSliders[kind] = w; mb.append(w.el);
    }
  }

  // ----- Color grading (its own section, like Lightroom's) -----
  {
    const gkeys = GRADE_PARAMS.map((p) => p[0]);
    const body = makeSection('grading', 'Color grading', { open: open.grading, keys: gkeys });
    grading = createGrading({
      params: P,
      live: () => { changed({ edit: true }); refresh(); },
      commit,
      setLum: (z, v) => setParam(`grade_${z}_lum`, v),
    });
    body.append(grading.el);
    GRADE_PARAMS.filter((p) => p[0] === 'grade_blend' || p[0] === 'grade_balance').forEach((row) => paramSlider(grading.blendHost, row));
    const hd = document.createElement('p'); hd.className = 'hint desk-only';
    hd.textContent = 'Hold Shift to change only the saturation, Ctrl (Cmd on a Mac) to change only the hue. Double-click a wheel to reset it.';
    const hm = document.createElement('p'); hm.className = 'hint m-only';
    hm.textContent = 'Swipe sideways or tap a tab. Double-tap a wheel to reset it.';
    body.append(hd, hm);
  }

  // ----- Effects -----
  {
    const body = makeSection('effects', 'Effects', { open: open.effects, keys: effectsKeys });
    PARAMS.filter((p) => p[5] === 'effects' && !p[6]).forEach((row) => paramSlider(body, row));
    for (const name of ['Vignette', 'Grain']) {
      const rows = PARAMS.filter((p) => p[5] === 'effects' && p[6] === name);
      const sb = makeSub(body, name.toLowerCase(), name, { keys: rows.map((r) => r[0]), parentId: 'effects', fixed: true });
      rows.forEach((row) => paramSlider(sb, row));
    }
  }

  // ----- Detail -----
  {
    const body = makeSection('detail', 'Detail', { open: open.detail, keys: detailKeys });
    for (const name of ['Sharpening', 'Noise reduction']) {
      const rows = PARAMS.filter((p) => p[5] === 'detail' && p[6] === name);
      const sb = makeSub(body, name === 'Sharpening' ? 'sharp' : 'nr', name, { keys: rows.map((r) => r[0]), parentId: 'detail', fixed: true });
      rows.forEach((row) => { const w = paramSlider(sb, row); if (row[0] === 'sharpMasking') maskViewHook(w.el); });
    }
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Detail effects are best judged at 100% zoom.';
    body.append(hint);
  }

  // ----- Optics -----
  {
    const optRows = PARAMS.filter((p) => p[5] === 'optics');
    const body = makeSection('optics', 'Optics', { open: open.optics, keys: optRows.map((r) => r[0]) });
    const row = document.createElement('label'); row.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    row.append(cb, 'Remove color fringing (auto)');
    cb.onchange = () => { setParam('caRemove', cb.checked ? 1 : 0); commit('Color fringing'); };
    checks.caRemove = cb;
    body.append(row);
    optRows.filter((r) => r[0] !== 'caRemove').forEach((r) => paramSlider(body, r));
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Distortion and vignetting are manual: this browser build has no lens profiles. Judge fringing at 100% zoom.';
    body.append(hint);
  }


  // ----- Calibration -----
  {
    const rows = PARAMS.filter((p) => p[5] === 'calibration');
    const body = makeSection('calibration', 'Calibration', { open: open.calibration, keys: rows.map((r) => r[0]) });
    const hint = document.createElement('p'); hint.className = 'hint'; hint.style.margin = '2px 16px 4px';
    hint.textContent = 'Adjusts the camera\'s colour primaries. Many presets use it for their colour character.';
    body.append(hint);
    const tracks = {
      calShadowTint: 'tint',
      calRedHue: 'linear-gradient(to right, hsl(325 80% 50%), hsl(0 80% 50%), hsl(38 90% 52%))',
      calRedSat: 'linear-gradient(to right, hsl(0 5% 50%), hsl(0 90% 50%))',
      calGreenHue: 'linear-gradient(to right, hsl(62 80% 48%), hsl(125 70% 42%), hsl(175 75% 45%))',
      calGreenSat: 'linear-gradient(to right, hsl(125 5% 50%), hsl(125 90% 42%))',
      calBlueHue: 'linear-gradient(to right, hsl(190 85% 50%), hsl(225 85% 55%), hsl(285 75% 55%))',
      calBlueSat: 'linear-gradient(to right, hsl(225 5% 50%), hsl(225 90% 55%))',
    };
    let lastGroup = '';
    for (const row of rows) {
      if (row[6] !== lastGroup) {       // plain headings, like Lightroom: no collapsible sub-panels
        lastGroup = row[6];
        const h = document.createElement('div'); h.className = 'group-title'; h.textContent = lastGroup; h.style.paddingTop = '12px';
        body.append(h);
      }
      const w = paramSlider(body, row, tracks[row[0]] === 'tint' ? { track: 'tint' } : {});
      if (tracks[row[0]] && tracks[row[0]] !== 'tint') w.setTrack(tracks[row[0]]);
    }
  }

  syncMix(); syncGrade();
  return { el, sync, refresh, histogram, setSolo };
}

export function setSolo(on) {
  soloOn = on; lsSet('solo', on ? '1' : '0');
  if (on) { const keep = Object.values(sections).find((s) => s.el.open)?.el; closeOthers(keep); const sub = Object.values(subs).find((s) => s.el.open && s.parent === Object.entries(sections).find(([, x]) => x.el === keep)?.[0]); closeOtherSubs(sub?.el); }
}
export const isSolo = () => soloOn;
if (soloOn) setTimeout(() => closeOthers(Object.values(sections).find((s) => s.el.open)?.el), 0);
