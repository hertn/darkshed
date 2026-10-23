import { app, bus, curItem, changed, commit, undo, redo, canUndo, canRedo, saveNow, renderState, visibleItems } from './app.js';
import { initViewport, setTool, zoomAt, zoomFit, zoom100, zoomToggle, readbackNow, invalidateAll, updateHud, view, geo } from './viewport.js';
import * as lib from './library.js';
import { isEdited } from './library.js';
import { createEditPanel, sync as editSync, refresh as editRefresh, setSolo, isSolo } from './ui/edit-panel.js';
import { createCropPanel } from './ui/crop-tool.js';
import { createMaskPanel } from './ui/mask-tool.js';
import { createSpotPanel } from './ui/spot-tool.js';
import { createPresetsPanel } from './ui/presets-panel.js';
import { createInfoPanel } from './ui/info-panel.js';
import { getLut } from './looks.js';
import { createGrid } from './ui/grid.js';
import { initMobile } from './mobile.js';
import { saveIndexNow, storageInfo, clearStored, keepPrefs } from './persist.js';
import './export.js';
import './sync.js';
import './ui/settings.js';
import './ui/about.js';
import { logoSvg } from './ui/logo.js';
import { icon, hydrateIcons } from './ui/icons.js';
import { menu, toast, modal } from './ui/overlays.js';
import { lsGet, lsSet } from './store.js';
import { clone, defaults, defaultCrop } from './params.js';

const $ = (id) => document.getElementById(id);

// ---------- icons ----------
const setIcon = (id, name, size = 20) => { $(id).innerHTML = icon(name, size); };
setIcon('btnMenu', 'menu'); setIcon('btnGrid', 'grid'); setIcon('btnUndo', 'undo'); setIcon('btnRedo', 'redo');
setIcon('btnCompare', 'compare'); setIcon('btnReset', 'reset'); setIcon('btnBefore', 'before');
$('btnExportIcon').innerHTML = icon('export', 16);
setIcon('zout', 'zoomOut', 17); setIcon('zin', 'zoomIn', 17);
setIcon('flagPick', 'flag', 16); setIcon('flagReject', 'reject', 16); setIcon('btnFilm', 'film', 17);
$('emptyIcon').innerHTML = logoSvg(84);
$('logo').innerHTML = logoSvg(26);
$('logo').onclick = () => bus.emit('open-about');
$('stars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button class="star" data-n="${n}" title="${n} star${n > 1 ? 's' : ''} (${n})">${icon('star', 15)}</button>`).join('');

// ---------- histogram + thumbnails ----------
let editPanel, histogram, thumbTimer = 0;
function onReadback(px) {
  histogram?.update(px);
  const copy = new Uint8ClampedArray(px.data), w = px.w, h = px.h, id = curItem()?.id;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { if (id) { lib.paintEditedThumb(id, copy, w, h); lib.refreshTiles(); } }, 300);
}

const grid = createGrid(document.getElementById('view'));
const lutLoading = new Set();
initViewport({
  onReadback,
  ensureLut: async (id) => {
    if (lutLoading.has(id)) return;
    lutLoading.add(id);
    const l = await getLut(id);
    lutLoading.delete(id);
    if (l && app.renderer) { app.renderer.setLut(l); changed({ edit: true }); }
  },
});

// ---------- panes / tools ----------
editPanel = createEditPanel();
histogram = editPanel.histogram;
const panes = {
  edit: { el: editPanel.el, impl: null },
  crop: createCropPanel({ setToolId: (id) => setToolId(id) }),
  spots: createSpotPanel(),
  mask: createMaskPanel(),
  presets: createPresetsPanel({ editSync: () => editSync() }),
  info: createInfoPanel(),
};
const RAIL = [['edit', 'edit', 'Edit (E)'], ['crop', 'crop', 'Crop & rotate (C)'], ['spots', 'heal', 'Healing (Q)'], ['mask', 'mask', 'Masking (M)'], ['presets', 'presets', 'Presets (P)'], ['info', 'info', 'Info (I)']];
const panel = $('panel'), rail = $('rail');
for (const [id] of RAIL) panel.append(panes[id].el);
for (const [id, ic, title] of RAIL) {
  const b = document.createElement('button'); b.className = 'ib'; b.title = title; b.dataset.tool = id; b.innerHTML = icon(ic, 22);
  b.onclick = () => setToolId(id);
  rail.append(b);
}
export function setToolId(id) {
  const prev = app.tool;
  panes[prev]?.onLeave?.();
  app.tool = id;
  for (const [pid, p] of Object.entries(panes)) p.el.classList.toggle('show', pid === id);
  for (const b of rail.children) b.classList.toggle('on', b.dataset.tool === id);
  setTool(panes[id].impl || null);
  panes[id].onEnter?.();
  changed({ geo: prev === 'crop' || id === 'crop', edit: false });
  invalidateAll();
  bus.emit('tool', id);
}
setToolId('edit');
initMobile({ setToolId });

// ---------- top bar ----------
function refreshTop() {
  const it = curItem();
  $('photoName').textContent = it ? it.name : '';
  { const vis = visibleItems(); const pos = vis.indexOf(it) + 1; $('photoCount').textContent = it ? `${pos || '–'} / ${vis.length}${vis.length < app.items.length ? ` (of ${app.items.length})` : ''}` : ''; }
  $('btnUndo').disabled = !canUndo(); $('btnRedo').disabled = !canRedo();
  $('btnExport').disabled = !it;
  $('btnCompare').classList.toggle('on', app.split != null);
}
$('btnReset').onclick = () => { const it = curItem(); if (it && isEdited(it)) { resetAll(); toast('Reset to original. Undo brings your edits back.'); } };
const refreshReset = () => { const it = curItem(); $('btnReset').disabled = !it || !isEdited(it); };
bus.on('history', refreshReset); bus.on('select', refreshReset); bus.on('badges', refreshReset);
$('btnGrid').onclick = () => grid.toggle();
bus.on('grid', (on) => $('btnGrid').classList.toggle('on', on));
$('btnUndo').onclick = () => undo();
$('btnRedo').onclick = () => redo();
$('btnCompare').onclick = () => { app.split = app.split == null ? 0.5 : null; refreshTop(); invalidateAll(); };
{
  const b = $('btnBefore');
  const set = (v) => { app.bypass = v; b.classList.toggle('on', v); invalidateAll(); };
  b.addEventListener('pointerdown', () => set(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => set(false));
}
bus.on('history', () => { refreshTop(); const it = curItem(); if (it) { lib.repaintTile(it); lib.updateTile(it); } });
bus.on('restored', () => { editSync(); lib.refreshTiles(); });
bus.on('sync-ui', () => editSync());

// ---------- bottom bar ----------
$('zfit').onclick = zoomFit; $('z100').onclick = zoom100;
$('zin').onclick = () => zoomAt(0, 0, 1.5); $('zout').onclick = () => zoomAt(0, 0, 1 / 1.5);
$('stars').addEventListener('click', (e) => { const b = e.target.closest('.star'); if (b) lib.setRating(+b.dataset.n); });
$('flagPick').onclick = () => lib.setFlag(1); $('flagReject').onclick = () => lib.setFlag(-1);
const filmOn = lsGet('film', '1') === '1';
$('strip').classList.toggle('hidden', !filmOn); $('btnFilm').classList.toggle('on', filmOn);
$('btnFilm').onclick = () => { const h = $('strip').classList.toggle('hidden'); $('btnFilm').classList.toggle('on', !h); lsSet('film', h ? '0' : '1'); };
function refreshMeta() {
  const it = curItem();
  document.querySelectorAll('#stars .star').forEach((s) => s.classList.toggle('on', !!it && +s.dataset.n <= it.rating));
  $('flagPick').classList.toggle('on', !!it && it.flag > 0);
  $('flagReject').classList.toggle('on', !!it && it.flag < 0);
}
bus.on('meta', refreshMeta);

// ---------- selection changes ----------
bus.on('select', (it) => {
  $('empty').classList.toggle('hidden', !!it);
  editSync(); refreshTop(); refreshMeta();
  if (!it) histogram.clear();
});
bus.on('library', refreshTop);
bus.on('filter', refreshTop);
bus.on('loading', (msg) => { const h = $('hud'); if (msg) { h.textContent = msg; h.classList.add('show'); } else updateHud(); });

// ---------- files ----------
const fileInput = document.createElement('input');
fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true;
fileInput.accept = '.raf,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2,image/*';
fileInput.onchange = () => { lib.addFiles(fileInput.files); fileInput.value = ''; };
document.body.append(fileInput);
$('fileEmpty').onchange = (e) => { lib.addFiles(e.target.files); e.target.value = ''; };
const openFiles = () => fileInput.click();
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) lib.addFiles(e.dataTransfer.files); });

// ---------- commands ----------
function copySettings() {
  const it = curItem(); if (!it) return;
  app.clip = { params: clone(it.params), off: [...it.off] };
  toast('Settings copied');
}
function pasteSettings() {
  if (!app.clip) { toast('Nothing copied yet'); return; }
  const targets = lib.selectedItems();
  for (const it of targets) {
    it.params = { ...clone(app.clip.params) };
    it.off = new Set(app.clip.off);
    if (it !== curItem()) { it.edited = false; saveNow(it); }
  }
  editSync(); changed({ edit: true }); commit('Paste settings');
  lib.refreshTiles();
  toast(targets.length > 1 ? `Pasted to ${targets.length} photos` : 'Settings pasted');
}
function resetAll() {
  const it = curItem(); if (!it) return;
  it.params = defaults(); it.off = new Set(); it.masks = []; it.spots = []; it.selectedMask = null; it.crop = defaultCrop();
  editSync(); changed({ edit: true, geo: true }); commit('Reset');
  bus.emit('masks-changed');
}
bus.on('cmd', (c) => {
  if (c === 'copy') copySettings();
  else if (c === 'paste') pasteSettings();
  else if (c === 'reset') resetAll();
  else if (c === 'open') openFiles();
  else if (c === 'export') $('btnExport').click();
});
$('btnExport').onclick = () => bus.emit('open-export');

// ---------- menu ----------
function shortcutsModal() {
  const rows = [
    ['Undo / redo', 'Ctrl/Cmd + Z / Shift + Z'], ['Before / after', '\\'], ['Next / previous photo', '→ / ←'],
    ['Zoom fit / 100%', 'Z'], ['Zoom in / out', '+ / −'], ['Rating', '0 – 5'], ['Pick / reject / unflag', 'P / X / U'],
    ['Grid / cull view', 'G'], ['Edit / crop / spot removal / masking / info', 'E / C / Q / M / I'], ['Mask overlay / spot visibility', 'O / H'], ['Copy / paste settings', 'Ctrl/Cmd + Shift + C / V'],
    ['Export', 'Ctrl/Cmd + E'], ['Pan', 'Space + drag'],
  ];
  modal('Keyboard shortcuts', (body) => {
    const dl = document.createElement('dl'); dl.className = 'info-grid'; dl.style.gridTemplateColumns = '1fr auto';
    for (const [a, b] of rows) { const dt = document.createElement('dt'); dt.textContent = a; dt.style.color = 'var(--fg2)'; const dd = document.createElement('dd'); dd.textContent = b; dd.style.color = 'var(--mut)'; dl.append(dt, dd); }
    body.append(dl);
    const n = document.createElement('p'); n.className = 'hint'; n.textContent = 'In the grid: arrows move, Enter opens, Shift / Ctrl-click selects several, then P / X / U or 0–5 apply to all selected.'; body.append(n);
  }, { buttons: [{ label: 'Close', primary: true, onClick: (m) => m.close() }] });
}
$('btnMenu').onclick = () => menu([
  { label: 'Add photos…', onClick: openFiles },
  { label: 'Export…', kb: 'Ctrl+E', onClick: () => $('btnExport').click() },
  'sep',
  { label: 'Copy settings', kb: 'Ctrl+Shift+C', onClick: copySettings },
  { label: 'Paste settings', kb: 'Ctrl+Shift+V', onClick: pasteSettings },
  { label: 'Reset all edits', onClick: resetAll },
  'sep',
  ...(document.body.classList.contains('m') ? [] : [{ label: 'Solo mode (one section open)', check: isSolo(), onClick: () => setSolo(!isSolo()) }]),
  { label: 'Show filmstrip', check: !$('strip').classList.contains('hidden'), onClick: () => $('btnFilm').click() },
  { label: 'Show performance stats', check: !!app.showHud, onClick: () => { app.showHud = !app.showHud; lsSet('hud', app.showHud ? '1' : '0'); updateHud(); } },
  'sep',
  { label: 'Sync & settings…', onClick: () => bus.emit('open-settings') },
  { label: 'Keyboard shortcuts', onClick: shortcutsModal },
  { label: 'About DarkShed', onClick: () => bus.emit('open-about') },
], $('btnMenu'));
app.showHud = lsGet('hud', '0') === '1';

// ---------- keyboard ----------
addEventListener('keydown', (e) => {
  const t = e.target;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'range' && t.type !== 'checkbox') return;
  if (t.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  if (mod) {
    if (k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.shiftKey && k.toLowerCase() === 'c') { e.preventDefault(); copySettings(); }
    else if (e.shiftKey && k.toLowerCase() === 'v') { e.preventDefault(); pasteSettings(); }
    else if (k.toLowerCase() === 'e') { e.preventDefault(); $('btnExport').click(); }
    return;
  }
  if (e.altKey) return;
  if (grid.visible() && grid.key(e)) { e.preventDefault(); return; }
  if (panes[app.tool]?.impl?.keydown?.(e)) return;
  if (k === 'ArrowRight') lib.step(1);
  else if (k === 'ArrowLeft') lib.step(-1);
  else if (k === 'g' || k === 'G') grid.toggle();
  else if (k === '\\') { app.bypass = !app.bypass; $('btnBefore').classList.toggle('on', app.bypass); invalidateAll(); }
  else if (k === 'z' || k === 'Z') zoomToggle();
  else if (k === '+' || k === '=') zoomAt(0, 0, 1.5);
  else if (k === '-') zoomAt(0, 0, 1 / 1.5);
  else if (/^[0-5]$/.test(k)) { const it = curItem(); if (it) { const n = +k; if (n === 0) { for (const x of lib.selectedItems()) { x.rating = 0; lib.updateTile(x); } bus.emit('meta'); } else { lib.setRating(n); } } }
  else if (k === 'p' || k === 'P') lib.setFlag(1);
  else if (k === 'x' || k === 'X') lib.setFlag(-1);
  else if (k === 'u' || k === 'U') lib.setFlag(0);
  else if (k === 'e' || k === 'E') setToolId('edit');
  else if (k === 'c' || k === 'C') setToolId('crop');
  else if (k === 'm' || k === 'M') setToolId('mask');
  else if (k === 'q' || k === 'Q') setToolId('spots');
  else if (k === 'i' || k === 'I') setToolId('info');
});

// ---------- leave safely ----------
addEventListener('pagehide', () => { lib.saveAll(); saveIndexNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { lib.saveAll(); saveIndexNow(); } });
bus.on('persist-error', () => toast('Could not keep a photo for later (device storage is full). It will be lost if the app reloads.', 6000));
const limitText = () => (keepPrefs.capMB ? (keepPrefs.capMB >= 1024 ? keepPrefs.capMB / 1024 + ' GB' : keepPrefs.capMB + ' MB') : 'no');
const dayText = () => (keepPrefs.days === 1 ? '1 day' : keepPrefs.days + ' days');
bus.on('persist-evicted', (n) => toast(`${n} older stored photo${n === 1 ? '' : 's'} removed to stay under your ${limitText()} limit. ${n === 1 ? 'It stays' : 'They stay'} open for now but won't come back after a reload.`, 7000));
bus.on('persist-expired', (n) => toast(`${n} stored photo${n === 1 ? '' : 's'} removed: not opened for ${dayText()}.`, 6000));
bus.on('low-space', (free) => toast(`This device is nearly out of space (${Math.round(free / 1048576)} MB free). Photos may not be kept for later.`, 8000));
bus.on('keep-notice', () => modal('Your photos stay on this device', (body) => {
  const p = document.createElement('p'); p.className = 'hint'; p.style.cssText = 'margin:6px 20px;font-size:13px;line-height:1.5;color:var(--fg2)';
  p.innerHTML = 'To keep your work safe if the app reloads (switching apps, a message, low memory), DarkShed stores a <b>copy of each photo you open</b>, in this browser and on this device only. Nothing is uploaded. Your originals in Photos or Files are never changed.';
  const q = document.createElement('p'); q.className = 'hint'; q.style.cssText = 'margin:8px 20px;font-size:13px;line-height:1.5;color:var(--fg2)';
  q.innerHTML = `A copy is deleted when you remove the photo from the library, <b>${keepPrefs.days ? dayText() + ' after you last opened or edited it' : 'never automatically'}</b>, or (oldest first) when stored photos pass <b>${limitText()}</b>. You can change all of this, or turn it off, in <b>Menu → Sync & settings</b>.`;
  body.append(p, q);
}, { buttons: [{ label: 'Settings', onClick: (m) => { m.close(); bus.emit('open-settings'); } }, { label: 'OK', primary: true, onClick: (m) => m.close() }] }));

// ---------- service worker (production only) ----------
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// exposed for other modules / tests
export { panes };
window.__app = { app, lib, setToolId, panes, setSolo, isSolo, view, geo, grid };

refreshTop(); refreshMeta();

// bring back the photos that were open before the page was reloaded / evicted (skipped in the headless test harness)
if (!new URLSearchParams(location.search).get('test')) lib.restore().catch((e) => { window.__restoreError = String((e && e.stack) || e); console.error('restore failed', e); });

// dev-only headless test hook
if (import.meta.env.DEV) import('./devtest.js');
