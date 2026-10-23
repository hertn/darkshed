// Presets pane: built-in looks, LUTs, user + imported Lightroom presets, each previewed on the current photo.
import { app, curItem, changed, commit, bus } from '../app.js';
import { clone } from '../params.js';
import { BUILTIN, applyLook, applyPreset, blendParams, previewParams, userPresets, loadUserPresets, savePreset, deletePreset, renamePreset, movePreset, renameGroup, updatePreset, importPresetFiles, listLuts, saveLut, getLut } from '../looks.js';
import { toXmp } from '../lrpreset.js';
import { zip } from '../zip.js';
import { validPreset } from '../merge.js';
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

  const groupList = [];     // { title, wrap, mine }: the phone shows one group at a time, picked with chips
  let curWrap = null;
  function section(title, mine = false) {
    const wrap = document.createElement('div'); wrap.className = 'pgroup'; body.append(wrap); curWrap = wrap; groupList.push({ title, wrap, mine });
    const t = document.createElement('div'); t.className = 'group-title'; t.textContent = title; wrap.append(t);
    if (mine) holdMenu(t, (a) => openCategoryMenu(title, a), t);
    const g = document.createElement('div'); g.className = 'preset-grid'; wrap.append(g); return g;
  }
  function hint(text) { const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '0 16px 8px'; p.textContent = text; (curWrap || body).append(p); }

  // right-click on desktop, press and hold on a phone
  function holdMenu(el, openMenu, anchor) {
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); });
    let timer = 0, sx = 0, sy = 0, held = false;
    el.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; held = false; timer = setTimeout(() => { timer = 0; held = true; openMenu(anchor || { x: sx, y: sy }); }, 550); }, { passive: true });
    el.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (timer && Math.hypot(t.clientX - sx, t.clientY - sy) > 8) { clearTimeout(timer); timer = 0; } }, { passive: true });
    el.addEventListener('touchend', (e) => { if (timer) { clearTimeout(timer); timer = 0; } if (held) { held = false; e.preventDefault(); } });
    el.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = 0; } });
  }
  // the outline follows whatever was applied last to this photo
  const lastApplied = (applyName) => { const it = curItem(); return !!(amountState && it && amountState.id === it.id && amountState.name === applyName); };
  function markActive(d) { for (const o of body.querySelectorAll('.preset.on')) o.classList.remove('on'); d.classList.add('on'); }
  function tile(grid, name, state, onClick, { items, active, applyName = name } = {}) {
    const d = document.createElement('div'); d.className = 'preset' + ((amountState && curItem()?.id === amountState.id ? lastApplied(applyName) : active) ? ' on' : ''); d.title = name;
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const s = document.createElement('span'); s.textContent = name;
    d.append(c, s);
    d.onclick = () => { onClick(); markActive(d); };
    if (items) {
      const more = document.createElement('button'); more.className = 'more'; more.textContent = '⋯'; more.title = 'Rename, move, update, delete…';
      more.onclick = (e) => { e.stopPropagation(); menu(items(), more); };
      d.append(more);
      holdMenu(d, (anchor) => menu(items(), anchor), more);
    }
    grid.append(d);
    tiles.push({ canvas: c, state });
    return d;
  }

  let rebuildSeq = 0;
  async function rebuild() {
    const seq = ++rebuildSeq;
    const it = curItem();
    // everything asynchronous first, so two rebuilds can never draw into the list at the same time
    const luts = it ? await listLuts() : [];
    const lutFull = await Promise.all(luts.map((l) => getLut(l.id)));
    if (seq !== rebuildSeq) return;
    body.textContent = ''; tiles.length = 0; groupList.length = 0; curWrap = null;
    if (!it) { body.innerHTML = '<p class="hint">Open a photo to preview looks.</p>'; return; }
    showAmount();
    const base = clone(it.params);
    const lookState = (patch, profile) => { const p = clone(base); applyLook(p, patch, profile); return { p }; };

    const g1 = section('Fujifilm-inspired looks');
    tile(g1, 'None', lookState({}, ''), () => applyLookPreset({}, 'None', ''));
    for (const l of BUILTIN) tile(g1, l.name, lookState(l.patch, 'b:' + l.name), () => applyLookPreset(l.patch, l.name, 'b:' + l.name), { active: base.profile === 'b:' + l.name });
    hint('Approximations built from the sliders. They are not Fujifilm\'s own film simulations.');

    if (luts.length) {
      const g2 = section('LUTs');
      luts.forEach((l, k) => {
        const p = clone(base); applyLook(p, {}, 'l:' + l.id); p.lut = l.id; p.lutAmount = 100;
        tile(g2, l.name, { p, lut: lutFull[k] }, () => applyLut(l.id, l.name), {
          active: base.lut === l.id, applyName: `LUT ${l.name}`,
          items: () => [
            { label: 'Apply', onClick: () => applyLut(l.id, l.name) },
            'sep',
            { label: 'Delete…', onClick: () => confirmDialog(`Delete LUT "${l.name}"?`, 'It is removed from this device and from your other devices if you sync. This cannot be undone.', 'Delete', async () => { await removeLutEverywhere(l.id); rebuild(); }) },
          ],
        });
      });
    } else hint('Import .cube files to use them as looks.');

    const mine = userPresets();
    const names = Object.keys(mine).filter((n) => n !== '__deleted' && validPreset(mine[n]));
    const groups = new Map();
    for (const n of names) { const g = mine[n].group || 'My presets'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
    if (!groups.size) { section('My presets', false); hint('Use "Save" to keep the current look, or "Import…" for Lightroom presets.'); }
    for (const [g, list] of [...groups].sort((a, b) => (a[0] === 'My presets' ? -1 : b[0] === 'My presets' ? 1 : a[0].localeCompare(b[0])))) {
      const grid = section(g, true);
      for (const n of list.sort((a, b) => a.localeCompare(b))) {
        const pr = mine[n];
        tile(grid, n, { p: previewParams(base, pr) }, () => applyStored(n, pr), {
          items: () => [
            { label: 'Apply', onClick: () => applyStored(n, pr) },
            { label: 'Rename…', onClick: () => renameDialog(n) },
            { label: 'Move to category…', onClick: () => moveDialog(n, g) },
            { label: 'Update with current settings…', onClick: () => updateDialog(n) },
            { label: 'Export as Lightroom preset (.xmp)', onClick: () => exportOne(n, pr) },
            'sep',
            { label: 'Delete…', onClick: () => confirmDialog(`Delete "${n}"?`, 'This preset is removed from this device and from your other devices if you sync. This cannot be undone.', 'Delete', async () => { await deletePreset(n); rebuild(); }) },
          ],
        });
      }
    }
    buildChips();
    renderThumbs();
  }

  // phone: a row of category chips; only the chosen category is shown, as one horizontal strip
  let activeGroup = '';
  const chips = document.createElement('div'); chips.className = 'pchips';
  function showGroup(title) {
    activeGroup = title;
    for (const g of groupList) g.wrap.classList.toggle('cur', g.title === title);
    for (const c of chips.children) c.classList.toggle('on', c.dataset.g === title);
    chips.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function buildChips() {
    chips.textContent = '';
    for (const g of groupList) {
      const b = document.createElement('button'); b.className = 'pchip'; b.dataset.g = g.title; b.textContent = g.title; b.onclick = () => showGroup(g.title); chips.append(b);
      if (g.mine) holdMenu(b, (a) => openCategoryMenu(g.title, a), b);
    }
    body.prepend(chips);
    const activeTile = groupList.find((g) => g.wrap.querySelector('.preset.on'))?.title;
    showGroup(groupList.some((g) => g.title === activeGroup) ? activeGroup : (activeTile || groupList[0]?.title || ''));
  }
  function openCategoryMenu(title, anchor) { menu([{ label: 'Rename category…', onClick: () => renameCategoryDialog(title) }], anchor); }

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
  /** Presets replace each other: first undo what the previous preset changed on this photo (settings you changed on other sliders stay). */
  function revertPrevious(it) {
    const st = amountState;
    if (!st || st.id !== it.id) return;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const k of new Set([...Object.keys(st.base), ...Object.keys(st.target)])) {
      if (same(st.base[k], st.target[k])) continue;
      if (st.base[k] === undefined) delete it.params[k]; else it.params[k] = clone(st.base[k]);
    }
  }
  function applyLookPreset(patch, label, profile) {
    const it = curItem(); if (!it) return;
    revertPrevious(it);
    const base = clone(it.params);
    applyLook(it.params, patch, profile);
    finishApply(it, base, label);
  }
  function applyStored(name, pr) {
    const it = curItem(); if (!it) return;
    revertPrevious(it);
    const base = clone(it.params);
    applyPreset(it.params, pr, '');
    if (pr.mode === 'merge') it.params.profile = base.profile;
    finishApply(it, base, name);
  }
  function applyLut(id, label) {
    const it = curItem(); if (!it) return;
    revertPrevious(it);
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
    const mine = userPresets(), names = Object.keys(mine).filter((n) => n !== '__deleted' && validPreset(mine[n]));
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
  function confirmDialog(title, text, okLabel, onOk) {
    modal(title, (b) => { const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '6px 20px 4px'; p.textContent = text; b.append(p); },
      { buttons: [{ label: 'Cancel', onClick: (m) => m.close() }, { label: okLabel, primary: true, onClick: (m) => { m.close(); onOk(); } }] });
  }
  function updateDialog(name) {
    const it = curItem(); if (!it) return;
    confirmDialog(`Update "${name}"?`, 'The preset is replaced with the current photo\'s settings. Its name and category stay. The old settings are lost.', 'Update', async () => { await updatePreset(name, it.params); toast(`Updated "${name}"`); rebuild(); });
  }
  function moveDialog(name, current) {
    const mine = userPresets();
    const cats = [...new Set(Object.keys(mine).filter((n) => n !== '__deleted' && validPreset(mine[n])).map((n) => mine[n].group || 'My presets'))].sort((a, b) => (a === 'My presets' ? -1 : b === 'My presets' ? 1 : a.localeCompare(b)));
    if (!cats.includes('My presets')) cats.unshift('My presets');
    const NEW = '\u0000new';
    let sel, inp;
    modal(`Move "${name}"`, (b) => {
      const row = document.createElement('div'); row.className = 'field-row';
      const lab = document.createElement('label'); lab.textContent = 'Category';
      sel = document.createElement('select');
      for (const c of cats) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.append(o); }
      const on = document.createElement('option'); on.value = NEW; on.textContent = 'New category…'; sel.append(on);
      sel.value = current;
      row.append(lab, sel); b.append(row);
      const row2 = document.createElement('div'); row2.className = 'field-row'; row2.style.display = 'none';
      const lab2 = document.createElement('label'); lab2.textContent = 'Name';
      inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 40; inp.placeholder = 'New category name';
      row2.append(lab2, inp); b.append(row2);
      sel.onchange = () => { row2.style.display = sel.value === NEW ? '' : 'none'; if (sel.value === NEW) inp.focus(); };
    }, { buttons: [{ label: 'Cancel', onClick: (m) => m.close() }, { label: 'Move', primary: true, onClick: async (m) => {
      const g = sel.value === NEW ? inp.value.trim() : sel.value;
      if (!g || g === '__deleted') return;
      m.close(); await movePreset(name, g); rebuild();
    } }] });
  }
  function renameCategoryDialog(old) {
    nameDialog('Rename category', old, async (n) => { await renameGroup(old, n); activeGroup = n; rebuild(); }, 'Every preset in this category moves to the new name.');
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
