// Presets pane: built-in looks, LUTs, user + imported Lightroom presets, each previewed on the current photo.
import { app, curItem, changed, commit, bus } from '../app.js';
import { clone } from '../params.js';
import { BUILTIN, applyLook, applyPreset, blendParams, previewParams, userPresets, loadUserPresets, savePreset, deletePreset, renamePreset, importPresetFiles, listLuts, saveLut, getLut } from '../looks.js';
import { toXmp } from '../lrpreset.js';
import { zip } from '../zip.js';
import { parseCube } from '../lut.js';
import { makeSmall } from '../decode.js';
import { slider } from './slider.js';
import { icon } from './icons.js';
import { modal, toast, menu } from './overlays.js';
import { removeLutEverywhere } from '../sync.js';

const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 20000); };
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'preset';

export function createPresetsPanel({ editSync }) {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'presets';
  el.innerHTML = '<div class="pane-title">Presets</div><div class="pane-sub">Click a look to apply it. Lightroom presets (.xmp, .lrtemplate, .zip packs) can be imported and exported.</div>';

  // ----- actions -----
  const actions = document.createElement('div'); actions.className = 'btn-row'; actions.style.paddingTop = '0';
  const mkBtn = (label, ic, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.innerHTML = icon(ic, 15) + label; b.onclick = (e) => fn(e, b); actions.append(b); return b; };
  mkBtn('Save', 'plus', saveDialog);
  const presetInput = document.createElement('input'); presetInput.type = 'file'; presetInput.hidden = true; presetInput.multiple = true;
  // iOS greys out file types it does not know (.xmp, .lrtemplate, .cube), so there it must show every file; the import skips anything it cannot use
  const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!IOS) presetInput.accept = '.xmp,.lrtemplate,.zip';
  presetInput.onchange = async () => { const files = [...presetInput.files]; presetInput.value = ''; if (files.length) await doImport(files); };
  mkBtn('Import…', 'import', () => presetInput.click());
  mkBtn('Export…', 'export', (e, b) => exportMenu(b));
  const lutInput = document.createElement('input'); lutInput.type = 'file'; if (!IOS) lutInput.accept = '.cube'; lutInput.hidden = true; lutInput.multiple = true;
  lutInput.onchange = async () => {
    for (const f of lutInput.files) {
      try { const l = parseCube(await f.text()); await saveLut((l.title || f.name.replace(/\.cube$/i, '')), l.size, l.data); toast(`Imported ${f.name}`); }
      catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
    lutInput.value = '';
  };
  mkBtn('LUT…', 'image', () => lutInput.click());
  el.append(actions, presetInput, lutInput);

  // ----- amount -----
  let amountState = null;      // { id, base, target, name }
  const amountBox = document.createElement('div');
  const amount = slider({
    label: 'Amount', min: 0, max: 200, step: 1, def: 100, value: 100, format: (v) => String(Math.round(v)),
    onInput: (v) => { const it = curItem(), st = amountState; if (!it || !st || st.id !== it.id) return; blendParams(it.params, st.base, st.target, v / 100); editSync(); changed({ edit: true }); },
    onChange: () => commit('Preset amount'),
  });
  amountBox.append(amount.el); amountBox.style.display = 'none';
  el.append(amountBox);
  const showAmount = () => { const it = curItem(); amountBox.style.display = amountState && it && amountState.id === it.id ? '' : 'none'; };

  const body = document.createElement('div'); el.append(body);
  let thumbsFor = null, building = 0;
  const tiles = [];

  function section(title) { const t = document.createElement('div'); t.className = 'group-title'; t.textContent = title; body.append(t); const g = document.createElement('div'); g.className = 'preset-grid'; body.append(g); return g; }
  function hint(text) { const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '0 16px 8px'; p.textContent = text; body.append(p); }
  function tile(grid, name, state, onClick, { onDelete, onMenu, active } = {}) {
    const d = document.createElement('div'); d.className = 'preset' + (active ? ' on' : ''); d.title = name;
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const s = document.createElement('span'); s.textContent = name;
    d.append(c, s);
    d.onclick = onClick;
    if (onMenu) d.oncontextmenu = (e) => { e.preventDefault(); onMenu(e); };
    if (onDelete) { const x = document.createElement('button'); x.className = 'del'; x.textContent = '×'; x.title = 'Delete'; x.onclick = (e) => { e.stopPropagation(); onDelete(); }; d.append(x); }
    grid.append(d);
    tiles.push({ canvas: c, state });
    return d;
  }

  async function rebuild() {
    body.textContent = ''; tiles.length = 0;
    const it = curItem();
    if (!it) { body.innerHTML = '<p class="hint">Open a photo to preview looks.</p>'; return; }
    showAmount();
    const base = clone(it.params);
    const lookState = (patch, profile) => { const p = clone(base); applyLook(p, patch, profile); return { p }; };

    const g1 = section('Fujifilm-inspired looks');
    tile(g1, 'None', lookState({}, ''), () => applyLookPreset({}, 'None', ''));
    for (const l of BUILTIN) tile(g1, l.name, lookState(l.patch, 'b:' + l.name), () => applyLookPreset(l.patch, l.name, 'b:' + l.name), { active: base.profile === 'b:' + l.name });
    hint('Approximations built from the sliders. They are not Fujifilm\'s own film simulations.');

    const luts = await listLuts();
    if (luts.length) {
      const g2 = section('LUTs');
      for (const l of luts) {
        const full = await getLut(l.id);
        const p = clone(base); applyLook(p, {}, 'l:' + l.id); p.lut = l.id; p.lutAmount = 100;
        tile(g2, l.name, { p, lut: full }, () => applyLut(l.id, l.name), { onDelete: async () => { await removeLutEverywhere(l.id); rebuild(); }, active: base.lut === l.id });
      }
    } else hint('Import .cube files to use them as looks.');

    const mine = userPresets();
    const names = Object.keys(mine).filter((n) => n !== '__deleted');
    const groups = new Map();
    for (const n of names) { const g = mine[n].group || 'My presets'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
    if (!groups.size) { const t = document.createElement('div'); t.className = 'group-title'; t.textContent = 'My presets'; body.append(t); hint('Use "Save" to keep the current look, or "Import…" for Lightroom presets.'); }
    for (const [g, list] of [...groups].sort((a, b) => (a[0] === 'My presets' ? -1 : b[0] === 'My presets' ? 1 : a[0].localeCompare(b[0])))) {
      const grid = section(g);
      for (const n of list.sort((a, b) => a.localeCompare(b))) {
        const pr = mine[n];
        tile(grid, n, { p: previewParams(base, pr) }, () => applyStored(n, pr), {
          onDelete: async () => { await deletePreset(n); rebuild(); },
          onMenu: (e) => menu([
            { label: 'Apply', onClick: () => applyStored(n, pr) },
            { label: 'Export as Lightroom preset (.xmp)', onClick: () => exportOne(n, pr) },
            { label: 'Rename…', onClick: () => renameDialog(n) },
            'sep',
            { label: 'Delete', onClick: async () => { await deletePreset(n); rebuild(); } },
          ], { x: e.clientX, y: e.clientY }),
        });
      }
    }
    renderThumbs();
  }

  function renderThumbs() {
    const r = app.renderer, L = app.loaded;
    if (!r || !L || !tiles.length) return;
    const token = ++building;
    if (thumbsFor !== L.img) { const sm = makeSmall(L.img, 192); r.setSmall(sm.w, sm.h, sm.half); thumbsFor = L.img; }
    let i = 0;
    const step = () => {
      if (token !== building) return;
      const batch = tiles.slice(i, i + 4);
      if (!batch.length) return;
      const out = r.renderThumbs(batch.map((t) => t.state));
      batch.forEach((t, k) => {
        const px = out[k], c = t.canvas, g = c.getContext('2d');
        const tmp = document.createElement('canvas'); tmp.width = px.w; tmp.height = px.h;
        tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
        const s = Math.max(c.width / px.w, c.height / px.h);
        g.drawImage(tmp, (c.width - px.w * s) / 2, (c.height - px.h * s) / 2, px.w * s, px.h * s);
      });
      i += 4;
      setTimeout(step, 0);
    };
    step();
  }

  // ----- applying (remembers the "before" so Amount can blend) -----
  function finishApply(it, base, name) {
    amountState = { id: it.id, base, target: clone(it.params), name };
    amount.set(100); showAmount();
    editSync(); changed({ edit: true }); commit(`Preset: ${name}`);
  }
  function applyLookPreset(patch, label, profile) {
    const it = curItem(); if (!it) return;
    const base = clone(it.params);
    applyLook(it.params, patch, profile);
    finishApply(it, base, label);
  }
  function applyStored(name, pr) {
    const it = curItem(); if (!it) return;
    const base = clone(it.params);
    applyPreset(it.params, pr, '');
    if (pr.mode === 'merge') it.params.profile = base.profile;
    finishApply(it, base, name);
  }
  function applyLut(id, label) {
    const it = curItem(); if (!it) return;
    const base = clone(it.params);
    applyLook(it.params, {}, 'l:' + id);
    it.params.lut = id; it.params.lutAmount = 100;
    finishApply(it, base, `LUT ${label}`);
  }

  // ----- import / export -----
  async function doImport(files) {
    const r = await importPresetFiles(files);
    await rebuild();
    modal('Import presets', (b) => {
      const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '6px 20px 4px';
      p.textContent = `${r.imported} preset${r.imported === 1 ? '' : 's'} imported.`;
      b.append(p);
      if (r.ignored.length) { const q = document.createElement('p'); q.className = 'hint'; q.style.margin = '4px 20px'; q.textContent = `Not supported here and skipped: ${r.ignored.join(', ')}.`; b.append(q); }
      if (r.failed.length) {
        const q = document.createElement('p'); q.className = 'hint'; q.style.margin = '4px 20px'; q.style.color = 'var(--warn)';
        q.textContent = 'Could not import: ' + r.failed.slice(0, 6).map((f) => `${f.file} (${f.error})`).join('; ') + (r.failed.length > 6 ? ` and ${r.failed.length - 6} more` : '');
        b.append(q);
      }
    }, { buttons: [{ label: 'OK', primary: true, onClick: (m) => m.close() }] });
    return r;
  }
  function exportOne(name, pr) {
    const xml = toXmp(name, { ...pr.patch }, { group: pr.group || 'User Presets' });
    download(new Blob([xml], { type: 'application/rdf+xml' }), safeName(name) + '.xmp');
  }
  async function exportAll() {
    const mine = userPresets(), names = Object.keys(mine).filter((n) => n !== '__deleted');
    if (!names.length) { toast('No presets to export yet'); return; }
    const files = names.map((n) => ({ name: `${safeName(mine[n].group || 'My presets')}/${safeName(n)}.xmp`, blob: new Blob([toXmp(n, mine[n].patch, { group: mine[n].group || 'User Presets' })], { type: 'application/rdf+xml' }) }));
    download(await zip(files), 'darkshed-presets.zip');
  }
  function exportCurrent() {
    const it = curItem(); if (!it) return;
    nameDialog('Export current settings', it.name, (n) => download(new Blob([toXmp(n, it.params)], { type: 'application/rdf+xml' }), safeName(n) + '.xmp'),
      'Writes a Lightroom preset (.xmp) with this photo\'s tone, color, effects and detail settings. Import it in Lightroom via Presets → Import.');
  }
  function exportMenu(anchor) {
    menu([
      { label: 'Current settings as Lightroom preset (.xmp)…', onClick: exportCurrent },
      { label: 'All my presets as ZIP of .xmp', onClick: exportAll },
    ], anchor);
  }

  function nameDialog(title, initial, onOk, note) {
    let input;
    modal(title, (b) => {
      const row = document.createElement('div'); row.className = 'field-row';
      const lab = document.createElement('label'); lab.textContent = 'Name';
      input = document.createElement('input'); input.type = 'text'; input.value = initial; input.maxLength = 60;
      row.append(lab, input); b.append(row);
      if (note) { const h = document.createElement('p'); h.className = 'hint'; h.textContent = note; b.append(h); }
      setTimeout(() => { input.focus(); input.select(); }, 30);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    }, { buttons: [{ label: 'Cancel', onClick: (m) => m.close() }, { label: 'OK', primary: true, onClick: () => ok() }] });
    function ok() { const n = input.value.trim(); if (!n || n === '__deleted') return; document.getElementById('modalRoot').textContent = ''; onOk(n); }
  }
  function saveDialog() {
    const it = curItem(); if (!it) return;
    nameDialog('Save preset', '', async (n) => { await savePreset(n, it.params); toast(`Saved "${n}"`); rebuild(); });
  }
  function renameDialog(old) {
    nameDialog('Rename preset', old, async (n) => { await renamePreset(old, n); rebuild(); });
  }

  bus.on('presets', () => { if (el.classList.contains('show')) rebuild(); });
  bus.on('luts', () => { if (el.classList.contains('show')) rebuild(); });
  bus.on('select', () => { thumbsFor = null; amountState = null; if (el.classList.contains('show')) rebuild(); });
  loadUserPresets();

  return { el, impl: null, onEnter() { rebuild(); }, onLeave() { building++; }, doImport };
}
