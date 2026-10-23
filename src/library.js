// Library: the list of open photos, selection, thumbnails, filmstrip, ratings / flags.
import { app, bus, curItem, makeItem, loadSaved, initHistory, changed, saveNow, scheduleSave, visibleItems } from './app.js';
import { loadImage, loadThumb, isRaw } from './decode.js';
import { setImage, resetView } from './viewport.js';
import { icon } from './ui/icons.js';
import { menu, toast, modal } from './ui/overlays.js';
import { makeGeo } from './geometry.js';
import { keepPhoto, keepThumb, forgetPhoto, saveIndex, readLibrary } from './persist.js';

const strip = document.getElementById('strip');
let nextId = 1, selToken = 0;
const cache = new Map();       // item id -> decoded proxy (small LRU)
const scratch = document.createElement('canvas');
let anchor = -1;               // shift-click range anchor

const OK_FILE = (f) => f.type.startsWith('image/') || isRaw(f) || /\.(heic|heif)$/i.test(f.name);

function cacheSet(id, img) {
  cache.delete(id); cache.set(id, img);
  for (const k of cache.keys()) { if (cache.size <= 3) break; if (k !== id) cache.delete(k); }
}
export const cachedImage = (id) => cache.get(id);

// ---------- thumbnails ----------
// Draw a thumbnail through the photo's crop / rotation / flip (cover-fit into the tile).
function paintTile(it) { drawThumb(it.cv, it, 'cover'); }
/** Draw a photo's thumbnail (through its crop) into any canvas; fit = 'cover' | 'contain'. */
export function drawThumb(cv, it, fit = 'cover') {
  const th = it.thumb;
  if (!cv || !th) return;
  const g = cv.getContext('2d'), cw = cv.width, ch = cv.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);
  const A = th.width / th.height, geo = makeGeo(it.crop, A, false), r = geo.rect;
  const k = fit === 'cover' ? Math.max(cw / r.w, ch / r.h) : Math.min(cw / r.w, ch / r.h);   // canvas px per height unit
  const ox = (cw - r.w * k) / 2, oy = (ch - r.h * k) / 2;
  const o = geo.srcToOut(0, 0), ex = geo.srcToOut(A / th.width, 0), ey = geo.srcToOut(0, 1 / th.height);
  g.setTransform((ex[0] - o[0]) * r.w * k, (ex[1] - o[1]) * r.h * k, (ey[0] - o[0]) * r.w * k, (ey[1] - o[1]) * r.h * k, o[0] * r.w * k + ox, o[1] * r.h * k + oy);
  g.drawImage(th, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
}
export const repaintTile = paintTile;
export function paintEditedThumb(id, data, w, h) {
  const it = app.items.find((x) => x.id === id);
  if (!it) return;
  scratch.width = w; scratch.height = h;
  scratch.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const own = it.thumbCv || (it.thumbCv = document.createElement('canvas'));
  own.width = w; own.height = h;
  own.getContext('2d').drawImage(scratch, 0, 0);
  it.thumb = own; it.edited = true;
  it.tile?.querySelector('.spin')?.remove();
  paintTile(it);
  clearTimeout(it._thumbSave); it._thumbSave = setTimeout(() => keepThumb(it, own), 1500);
}

// ---------- filmstrip ----------
const stars = (n) => '★'.repeat(n);
export function renderStrip() {
  strip.textContent = '';
  const items = visibleItems();
  for (const it of app.items) { it.tile = null; it.cv = null; }
  items.forEach((it) => {
    const tile = document.createElement('div');
    tile.title = it.name;
    const cv = document.createElement('canvas'); cv.width = 200; cv.height = 160;
    tile.append(cv);
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = `<span class="nm"></span><span class="st"></span>`;
    meta.querySelector('.nm').textContent = it.name;
    tile.append(meta);
    tile.addEventListener('pointerdown', (e) => onTileDown(e, it));
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); onTileMenu(e, it); });
    it.tile = tile; it.cv = cv;
    strip.append(tile);
    paintTile(it);
    if (!it.thumb) { const sp = document.createElement('span'); sp.className = 'spin'; sp.textContent = '…'; tile.append(sp); }
    updateTile(it);
  });
  if (items.length) {
    const add = document.createElement('label'); add.className = 'tile add'; add.title = 'Add photos';
    add.innerHTML = icon('plus', 22) + '<input type="file" multiple hidden accept=".raf,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2,image/*">';
    add.querySelector('input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    strip.append(add);
  }
}
export function updateTile(it) {
  const t = it.tile; if (!t) return;
  const i = app.items.indexOf(it);
  t.className = 'tile' + (i === app.cur ? ' on' : '') + (app.sel.has(it.id) ? ' sel' : '') + (it.flag < 0 ? ' rejected' : '');
  t.querySelector('.st').textContent = stars(it.rating);
  t.querySelector('.flag')?.remove(); t.querySelector('.edited')?.remove();
  if (it.flag) { const f = document.createElement('span'); f.className = 'flag ' + (it.flag > 0 ? 'pick' : 'reject'); f.innerHTML = icon(it.flag > 0 ? 'flag' : 'reject', 14); t.append(f); }
  if (isEdited(it)) { const d = document.createElement('i'); d.className = 'edited'; t.append(d); }
}
export function isEdited(it) {
  return JSON.stringify(it.params) !== JSON.stringify(refDefaults()) || it.masks.length > 0 || (it.spots && it.spots.length > 0) || it.crop.angle || it.crop.rot90 || it.crop.flipH || it.crop.flipV || !!it.crop.rect;
}
let _defaults = null;
function refDefaults() { return _defaults || (_defaults = makeItem(new File([], 'x'), 0).params); }
export function refreshTiles() { app.items.forEach(updateTile); }
function markActive() {
  refreshTiles();
  const t = curItem()?.tile;
  t?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function onTileDown(e, it) {
  if (e.button === 2) return;
  const i = app.items.indexOf(it);
  if (e.metaKey || e.ctrlKey) {
    app.sel.has(it.id) ? app.sel.delete(it.id) : app.sel.add(it.id);
    anchor = i; refreshTiles(); return;
  }
  if (e.shiftKey && anchor >= 0) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    app.sel = new Set(app.items.slice(a, b + 1).map((x) => x.id));
    refreshTiles(); return;
  }
  anchor = i;
  app.sel = new Set([it.id]);
  select(i);
}
function onTileMenu(e, it) {
  if (!app.sel.has(it.id)) { app.sel = new Set([it.id]); refreshTiles(); }
  const n = app.sel.size;
  menu([
    { label: 'Copy settings', onClick: () => bus.emit('cmd', 'copy') },
    { label: n > 1 ? `Paste settings to ${n} photos` : 'Paste settings', onClick: () => bus.emit('cmd', 'paste'), disabled: !app.clip },
    'sep',
    { label: n > 1 ? `Export ${n} photos…` : 'Export…', onClick: () => bus.emit('cmd', 'export') },
    'sep',
    { label: 'Pick', kb: 'P', onClick: () => setFlag(1) },
    { label: 'Reject', kb: 'X', onClick: () => setFlag(-1) },
    { label: 'Unflag', kb: 'U', onClick: () => setFlag(0) },
    'sep',
    { label: n > 1 ? `Remove ${n} from library…` : 'Remove from library…', onClick: () => confirmRemoveSelected() },
  ], { x: e.clientX, y: e.clientY });
}

// ---------- ratings / flags ----------
export const selectedItems = () => { const s = app.items.filter((x) => app.sel.has(x.id)); return s.length ? s : (curItem() ? [curItem()] : []); };
export function setRating(n) {
  const list = selectedItems();
  for (const it of list) { it.rating = it.rating === n ? 0 : n; scheduleSave(it); updateTile(it); }
  bus.emit('meta');
}
export function setFlag(f) {
  for (const it of selectedItems()) { it.flag = it.flag === f ? 0 : f; scheduleSave(it); updateTile(it); }
  bus.emit('meta');
}

// ---------- adding / selecting / removing ----------
export async function addFiles(fileList, { restore = false, thumbs = null, selectKey = null } = {}) {
  const files = [...fileList].filter(OK_FILE);
  if (!files.length) { toast('No supported images in that selection'); return; }
  const first = app.items.length;
  const added = [];
  for (const f of files) {
    const it = makeItem(f, nextId++);
    if (app.items.some((x) => x.key === it.key)) continue;               // already open
    const t = thumbs?.get(it.key); if (t) it.thumb = t;
    added.push(it);
  }
  if (!added.length) { toast('Those photos are already open'); return; }
  app.items.push(...added);
  await Promise.all(added.map((it) => loadSaved(it)));
  if (!restore) for (const it of added) keepPhoto(it);                    // keep originals on the device so a reload doesn't lose them
  renderStrip();
  bus.emit('library');
  const start = selectKey ? Math.max(0, app.items.findIndex((x) => x.key === selectKey)) : first;
  await select(start);
  // thumbnails for the rest, one at a time (embedded RAW previews are fast)
  for (const it of added) {
    if (it.thumb || !app.items.includes(it)) continue;
    const bmp = await loadThumb(it.file);
    if (bmp && !it.edited) { it.thumb = bmp; keepThumb(it, bmp); }
    it.tile?.querySelector('.spin')?.remove();
    paintTile(it);
  }
  saveIndex();
}

/** Re-open whatever was open before the page was reloaded. */
export async function restore() {
  const saved = await readLibrary();
  if (!saved) return false;
  bus.emit('loading', 'Restoring your photos…');
  await addFiles(saved.files, { restore: true, thumbs: saved.thumbs, selectKey: saved.cur });
  bus.emit('loading', null);
  return true;
}

export async function select(i) {
  const items = app.items;
  if (i < 0 || i >= items.length) return;
  const token = ++selToken, it = items[i];
  let img = cache.get(it.id);
  try {
    if (!img) {
      bus.emit('loading', `Opening ${it.name}…`);
      img = await loadImage(it.file, (s) => bus.emit('loading', `${it.name}: ${s}`));
    }
  } catch (e) {
    console.error(e);
    bus.emit('loading', null);
    toast(`Couldn't open ${it.name}: ${e.message || e}`, 4000);
    return;
  }
  if (token !== selToken) return;
  bus.emit('loading', null);
  cacheSet(it.id, img);
  app.cur = i;
  app.sel = app.sel.has(it.id) && app.sel.size > 1 ? app.sel : new Set([it.id]);
  app.loaded = { info: img.info, width: img.width, height: img.height, fullW: img.fullW, fullH: img.fullH, img, spotSig: '[]' };
  if (!it.hist) initHistory(it);
  setImage(img);
  resetView();
  markActive();
  bus.emit('select', it);
  bus.emit('item-used', it);
  changed({ edit: true, geo: true });
}

/** Move to the next / previous photo that passes the filter. */
export function step(d) {
  const vis = visibleItems(), cur = curItem();
  const i = vis.indexOf(cur);
  const next = vis[Math.min(vis.length - 1, Math.max(0, (i < 0 ? 0 : i) + d))];
  if (next && next !== cur) return select(app.items.indexOf(next));
}
bus.on('library', () => { renderStrip(); saveIndex(); });
bus.on('select', () => saveIndex());

/** Ask first; removing deletes the stored copy kept in this browser. The original file is never touched. */
export function confirmRemoveSelected() {
  const n = selectedItems().length; if (!n) return;
  modal(n > 1 ? `Remove ${n} photos?` : 'Remove this photo?', (b) => {
    const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '6px 20px 4px';
    p.textContent = 'It is removed from DarkShed, and the copy stored on this device is deleted. Your original file in Photos or Files is not touched.';
    b.append(p);
  }, { buttons: [{ label: 'Cancel', onClick: (m) => m.close() }, { label: 'Remove', primary: true, onClick: (m) => { m.close(); removeSelected(); } }] });
}
export function removeSelected() {
  const ids = new Set(selectedItems().map((x) => x.id));
  const curId = curItem()?.id;
  for (const x of app.items) if (ids.has(x.id)) forgetPhoto(x.key);
  app.items = app.items.filter((x) => !ids.has(x.id));
  for (const id of ids) cache.delete(id);
  app.sel = new Set();
  renderStrip();
  bus.emit('library');
  if (!app.items.length) { app.cur = -1; app.loaded = null; selToken++; bus.emit('select', null); document.getElementById('empty').classList.remove('hidden'); return; }
  if (ids.has(curId)) select(Math.min(app.cur < 0 ? 0 : app.cur, app.items.length - 1));
  else { app.cur = app.items.findIndex((x) => x.id === curId); markActive(); }
}

export async function saveAll() { await Promise.all(app.items.map((it) => saveNow(it))); }
export { markActive };
