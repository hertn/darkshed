// Central app state: library, per-photo edit state, undo history, event bus.
import { defaults, defaultCrop, clone, identityCurves, KEY_DEFAULT, migrateMask } from './params.js';
import { idb } from './store.js';

const listeners = {};
export const bus = {
  on(evt, fn) { (listeners[evt] ||= new Set()).add(fn); return () => listeners[evt].delete(fn); },
  emit(evt, data) { for (const fn of listeners[evt] || []) fn(data); },
};

export const app = {
  items: [],
  cur: -1,
  sel: new Set(),            // selected item ids (multi-select in the filmstrip)
  tool: 'edit',              // edit | crop | mask | presets | info
  clip: null,                // copied settings
  bypass: false,             // holding "before"
  split: null,               // null or 0..1 before/after divider
  renderer: null,
  loaded: null,              // { info, width, height, img } of the image on screen
};

export const curItem = () => app.items[app.cur] || null;

// ---------- library filter / sort (shared by the filmstrip and the grid) ----------
app.filter = (() => { try { return { flag: 'all', minRating: 0, sort: 'added', ...JSON.parse(localStorage.getItem('libFilter') || '{}') }; } catch { return { flag: 'all', minRating: 0, sort: 'added' }; } })();
export function setFilter(patch) {
  Object.assign(app.filter, patch);
  try { localStorage.setItem('libFilter', JSON.stringify(app.filter)); } catch {}
  bus.emit('library'); bus.emit('filter');
}
/** Items that pass the filter, in display order. The current photo always stays visible. */
export function visibleItems(strict = false) {
  const f = app.filter;
  let list = app.items.filter((it) => (!strict && it === app.items[app.cur])
    || ((f.flag === 'all' || (f.flag === 'pick' && it.flag > 0) || (f.flag === 'reject' && it.flag < 0) || (f.flag === 'none' && !it.flag)) && it.rating >= f.minRating));
  if (f.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (f.sort === 'rating') list = [...list].sort((a, b) => b.rating - a.rating);
  else if (f.sort === 'date') list = [...list].sort((a, b) => a.file.lastModified - b.file.lastModified);
  return list;
}
export const keyOf = (file) => `${file.name}|${file.size}|${file.lastModified}`;

// ---------- per-photo state ----------
export function newEditState() {
  return { params: defaults(), off: new Set(), masks: [], spots: [], crop: defaultCrop(), rating: 0, flag: 0 };
}

export function makeItem(file, id) {
  return {
    id, file, key: keyOf(file), name: file.name.replace(/\.[^.]+$/, ''),
    ...newEditState(),
    thumb: null, edited: false, hist: null, selectedMask: null,
  };
}

/** Serializable edit state (what gets autosaved and what undo snapshots hold). */
export const editOf = (it) => ({
  params: clone(it.params), off: [...it.off], masks: clone(it.masks), spots: clone(it.spots || []), crop: clone(it.crop),
});
export const fullOf = (it) => ({ ...editOf(it), rating: it.rating, flag: it.flag });

export function applyEdit(it, e) {
  it.params = { ...defaults(), ...clone(e.params || {}) };
  it.params.curves = { ...identityCurves(), ...(it.params.curves || {}) };
  it.off = new Set(e.off || []);
  it.masks = clone(e.masks || []);
  for (const m of it.masks) { migrateMask(m); for (const c of m.comps) c.rev++; }
  it.spots = clone(e.spots || []);
  it.crop = { ...defaultCrop(), ...clone(e.crop || {}) };
}

// ---------- history ----------
const HIST_MAX = 120;
export function initHistory(it) {
  const snap = JSON.stringify(editOf(it));
  it.hist = { stack: [snap], idx: 0, labels: ['Open'] };
}
/** Record the current edit state as an undo step (no-op when nothing changed). */
export function commit(label = 'Edit') {
  const it = curItem();
  if (!it) return;
  if (!it.hist) initHistory(it);
  const snap = JSON.stringify(editOf(it));
  const h = it.hist;
  if (h.stack[h.idx] === snap) return;
  h.stack.length = h.idx + 1;
  h.stack.push(snap); h.labels.length = h.idx + 1; h.labels.push(label);
  if (h.stack.length > HIST_MAX) { h.stack.shift(); h.labels.shift(); }
  h.idx = h.stack.length - 1;
  scheduleSave(it);
  bus.emit('history');
}
export function undo() { step(-1); }
export function redo() { step(1); }
function step(d) {
  const it = curItem();
  if (!it?.hist) return;
  const h = it.hist, i = h.idx + d;
  if (i < 0 || i >= h.stack.length) return;
  h.idx = i;
  applyEdit(it, JSON.parse(h.stack[i]));
  scheduleSave(it);
  bus.emit('restored');
  changed({ edit: true, geo: true });
  bus.emit('history');
}
export const canUndo = () => { const h = curItem()?.hist; return !!h && h.idx > 0; };
export const canRedo = () => { const h = curItem()?.hist; return !!h && h.idx < h.stack.length - 1; };

// ---------- change notification ----------
/** Tell the viewport something changed. edit: pixels need re-editing; geo: crop changed; brush: strokes changed. */
export function changed(flags = { edit: true }) { bus.emit('changed', flags); }

// ---------- autosave ----------
const saveTimers = new Map();
export function scheduleSave(it) {
  bus.emit('item-used', it);
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(it.id, setTimeout(() => saveNow(it), 700));
}
export function saveNow(it) {
  if (!it?.key) return Promise.resolve();
  return idb.set('edits', it.key, { ...fullOf(it), savedAt: Date.now() }).catch(() => {});
}
export async function loadSaved(it) {
  try {
    const s = await idb.get('edits', it.key);
    if (!s) return false;
    applyEdit(it, s);
    it.rating = s.rating || 0; it.flag = s.flag || 0;
    return true;
  } catch { return false; }
}

// ---------- section power toggles ----------
// Which params / structures each top-level section owns (used to switch a whole section off)
export const SECTION_KEYS = {};
export function registerSection(id, keys, extra = {}) { SECTION_KEYS[id] = { keys, ...extra }; }

/** The render state: params with switched-off sections neutralised, and only enabled masks. */
export function renderState(it) {
  let p = it.params;
  if (it.off.size) {
    p = { ...p };
    for (const id of it.off) {
      const s = SECTION_KEYS[id]; if (!s) continue;
      for (const k of s.keys) p[k] = KEY_DEFAULT[k] ?? 0;
      if (s.curves) p.curves = identityCurves();
      if (s.resetFn) s.resetFn(p);
    }
  }
  const masks = it.masks.filter((m) => m.enabled !== false);
  return { p, masks, raw: /\.(raf|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|x3f|raw|3fr|iiq|erf|mrw|kdc|dcr)$/i.test(it.file?.name || '') };
}
