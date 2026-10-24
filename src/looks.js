// Built-in looks (Fujifilm-inspired approximations), user presets and LUT library.
import { defaults, KEY_DEFAULT, PARAMS, HSL_PARAMS, GRADE_PARAMS, identityCurves, clone } from './params.js';
import { idb } from './store.js';
import { bus } from './app.js';
import { ALL_PARAMS } from './params.js';
import { parsePresetText } from './lrpreset.js';
import { unzip } from './zip.js';
import { validPreset } from './merge.js';

// Keys a "look" owns. Applying a look resets these, then applies its patch; exposure, white balance and detail stay yours.
const KEEP = new Set(['exposure', 'temp', 'tint', 'sharpAmount', 'sharpRadius', 'sharpMasking', 'nrLuma', 'nrColor', 'caRemove', 'defringePurple', 'defringeGreen', 'caRed', 'caBlue', 'distortion', 'lensVignette']);
export const LOOK_KEYS = [...PARAMS, ...HSL_PARAMS, ...GRADE_PARAMS].map((p) => p[0]).filter((k) => !KEEP.has(k));

export function applyLook(params, patch, profile = '') {
  const d = defaults();
  for (const k of LOOK_KEYS) params[k] = d[k];
  params.bw = 0; params.lut = null; params.lutAmount = 100; params.curves = identityCurves(); params.profile = profile;
  for (const [k, v] of Object.entries(patch)) params[k] = clone(v);
  if (patch.curves) params.curves = { ...identityCurves(), ...clone(patch.curves) };
}
/** Snapshot of the current look keys (what a user preset stores). */
export function snapshotLook(params) {
  const o = {};
  for (const k of LOOK_KEYS) if (params[k] !== KEY_DEFAULT[k]) o[k] = params[k];
  if (params.bw) o.bw = 1;
  if (params.lut) { o.lut = params.lut; o.lutAmount = params.lutAmount; }
  o.curves = clone(params.curves);
  return o;
}

const S = (a) => a;       // readability
export const BUILTIN = [
  { name: 'Provia', patch: { contrast: 11, vibrance: 8, saturation: 4 } },
  { name: 'Velvia', patch: { contrast: 40, saturation: 26, vibrance: 12, shadows: -8, blacks: -12, whites: 6, clarity: 6, hsl_green_sat: 12, hsl_blue_sat: 14, hsl_red_sat: 8 } },
  { name: 'Astia', patch: { contrast: -11, saturation: 6, highlights: -18, shadows: 10, clarity: -4, hsl_orange_lum: 8, hsl_orange_sat: -6, hsl_blue_sat: 6 } },
  { name: 'Classic Chrome', patch: { contrast: 29, saturation: -22, vibrance: -4, highlights: -14, shadows: 6, blacks: 12, hsl_red_sat: -10, hsl_green_sat: -20, hsl_blue_sat: -18, hsl_blue_lum: -14,
      grade_shadow_hue: 215, grade_shadow_sat: 13, grade_high_hue: 42, grade_high_sat: 9,
      curves: { rgb: S([[0, 0.04], [0.25, 0.2], [0.75, 0.8], [1, 0.98]]) } } },
  { name: 'Classic Neg', patch: { contrast: 36, saturation: -6, blacks: 10, highlights: -8, grainAmount: 14, grainSize: 30, hsl_green_hue: -12, hsl_blue_sat: -8,
      grade_shadow_hue: 175, grade_shadow_sat: 23, grade_mid_hue: 28, grade_mid_sat: 8, grade_high_hue: 48, grade_high_sat: 21,
      curves: { rgb: S([[0, 0.03], [0.3, 0.26], [0.7, 0.76], [1, 1]]) } } },
  { name: 'Pro Neg Std', patch: { contrast: -15, saturation: -6, highlights: -12, shadows: 8 } },
  { name: 'Pro Neg Hi', patch: { contrast: 25, saturation: 6, highlights: -8 } },
  { name: 'Eterna', patch: { contrast: -36, saturation: -14, highlights: -24, shadows: 20, blacks: 8, grade_shadow_hue: 190, grade_shadow_sat: 15,
      curves: { rgb: S([[0, 0.05], [0.5, 0.5], [1, 0.95]]) } } },
  { name: 'Nostalgic Neg', patch: { contrast: 22, saturation: 6, blacks: 14, highlights: -10, grainAmount: 10, hsl_blue_sat: -14, hsl_orange_sat: 10,
      grade_shadow_hue: 30, grade_shadow_sat: 19, grade_high_hue: 42, grade_high_sat: 26, grade_global_hue: 30, grade_global_sat: 6 } },
  { name: 'Acros', patch: { bw: 1, contrast: 44, blacks: -14, whites: 8, clarity: 12, grainAmount: 24, grainSize: 28, grainRoughness: 55,
      hsl_red_lum: 18, hsl_orange_lum: 12, hsl_yellow_lum: 8, hsl_green_lum: 6, hsl_blue_lum: -26 } },
  { name: 'Acros + R', patch: { bw: 1, contrast: 51, blacks: -16, whites: 8, clarity: 14, grainAmount: 24, grainSize: 28, grainRoughness: 55,
      hsl_red_lum: 45, hsl_orange_lum: 30, hsl_yellow_lum: 15, hsl_green_lum: -10, hsl_aqua_lum: -25, hsl_blue_lum: -50 } },
  { name: 'Sepia', patch: { bw: 1, contrast: 15, blacks: 6, grade_global_hue: 35, grade_global_sat: 28, grade_shadow_hue: 28, grade_shadow_sat: 19 } },
  { name: 'Faded', patch: { contrast: -22, saturation: -12, blacks: 26, highlights: -10, curves: { rgb: S([[0, 0.08], [0.5, 0.5], [1, 0.96]]) } } },
];

/** Apply a stored preset. 'merge' presets (Lightroom imports) change only the settings they list; others replace the whole look. */
export function applyPreset(params, preset, profile = '') {
  if (preset.mode === 'merge') {
    for (const [k, v] of Object.entries(preset.patch)) {
      if (k === 'curves') { params.curves = { ...params.curves }; for (const [ch, pts] of Object.entries(v)) params.curves[ch] = clone(pts); }
      else params[k] = v;
    }
  } else applyLook(params, preset.patch, profile);
}

const RANGE = Object.fromEntries(ALL_PARAMS.map((p) => [p[0], [p[2], p[3], p[4]]]));
/** Blend between the photo's settings before a preset (base) and after it (target); amount 0..2 (100% = the preset itself). */
export function blendParams(params, base, target, amount) {
  for (const k of Object.keys(target)) {
    const a = base[k], b = target[k];
    if (typeof b === 'number' && typeof a === 'number' && a !== b && RANGE[k]) {
      const [lo, hi, step] = RANGE[k];
      const v = Math.min(hi, Math.max(lo, a + (b - a) * amount));
      params[k] = Math.round(v / step) * step;
    }
  }
  const same = (x, y) => x.length === y.length && x.every((p, i) => Math.abs(p[0] - y[i][0]) < 1e-6);
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    const ca = base.curves[ch], cb = target.curves[ch];
    if (JSON.stringify(ca) === JSON.stringify(cb)) continue;
    params.curves[ch] = same(ca, cb) ? cb.map((p, i) => [p[0], Math.min(1, Math.max(0, ca[i][1] + (p[1] - ca[i][1]) * amount))]) : clone(amount >= 0.5 ? cb : ca);
  }
  if (base.bw !== target.bw) params.bw = amount >= 0.5 ? target.bw : base.bw;
  if (base.lut !== target.lut) { params.lut = amount > 0 ? target.lut : base.lut; params.lutAmount = Math.round(Math.min(100, (target.lutAmount ?? 100) * amount)); }
  params.profile = amount > 0 ? target.profile : base.profile;
}

/** Import Lightroom presets (.xmp / .lrtemplate / .zip packs). Returns { imported, failed: [{file, error}], ignored: [..] }. */
export async function importPresetFiles(files) {
  const entries = [];
  for (const f of files) {
    const ext = f.name.toLowerCase().replace(/^.*\./, '');
    if (ext === 'zip') {
      const packName = f.name.replace(/\.zip$/i, '');
      try { for (const e of await unzip(f)) entries.push({ name: e.name, blob: e.blob, pack: packName }); } catch (err) { entries.push({ name: f.name, error: err.message }); }
    } else entries.push({ name: f.name, blob: f, pack: '' });
  }
  if (!loaded) await loadUserPresets();
  const res = { imported: 0, failed: [], ignored: new Set() };
  for (const e of entries) {
    if (e.error) { res.failed.push({ file: e.name, error: e.error }); continue; }
    if (!/\.(xmp|lrtemplate)$/i.test(e.name)) continue;
    try {
      const r = parsePresetText(e.name, await e.blob.text());
      if (!Object.keys(r.patch).length) { res.failed.push({ file: e.name, error: 'no settings this editor understands' }); r.ignored.forEach((x) => res.ignored.add(x)); continue; }
      const parts = e.name.split('/'); const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : '';
      const group = r.group || folder || e.pack || 'Imported';
      let name = r.name, n = 2;
      while (user[name] && !(user[name].group === group && JSON.stringify(user[name].patch) === JSON.stringify(r.patch))) name = `${r.name} (${n++})`;
      user[name] = { patch: r.patch, mode: 'merge', group, updatedAt: Date.now(), source: 'lightroom' };
      r.ignored.forEach((x) => res.ignored.add(x));
      res.imported++;
    } catch (err) { res.failed.push({ file: e.name, error: err.message }); }
  }
  res.ignored = [...res.ignored];
  await persist();
  return res;
}

/** Apply a stored preset to a copy of params -> params (used for thumbnails and exports). */
export function previewParams(base, preset, profile = '') { const p = clone(base); applyPreset(p, preset, profile); return p; }

/** Apply a Profile dropdown value: '' (default), 'b:<name>' built-in look or 'l:<id>' LUT. */
export function applyProfile(params, value) {
  if (value && value.startsWith('b:')) { const l = BUILTIN.find((x) => x.name === value.slice(2)); applyLook(params, l ? l.patch : {}, value); }
  else if (value && value.startsWith('l:')) { applyLook(params, {}, value); params.lut = value.slice(2); params.lutAmount = 100; }
  else applyLook(params, {}, '');
}

// ---------- user presets ----------
let user = {};
let loaded = false;
export const userPresets = () => user;
export async function loadUserPresets() {
  try { user = (await idb.get('kv', 'presets')) || {}; } catch { user = {}; }
  for (const n of Object.keys(user)) if (n !== '__deleted' && !validPreset(user[n])) delete user[n];     // stray entries must never break the panel
  loaded = true; bus.emit('presets');
  return user;
}
async function persist() { try { await idb.set('kv', 'presets', user); } catch {} bus.emit('presets'); bus.emit('presets-changed-local'); }
export async function savePreset(name, params) {
  if (!loaded) await loadUserPresets();
  user[name] = { patch: snapshotLook(params), mode: 'replace', group: user[name]?.group || '', updatedAt: Date.now() };
  await persist();
}
export async function deletePreset(name) {
  if (!loaded) await loadUserPresets();
  delete user[name];
  // tombstone so a sync can propagate the delete
  user.__deleted = { ...(user.__deleted || {}), [name]: Date.now() };
  await persist();
}
export async function renamePreset(oldName, newName) {
  if (!loaded) await loadUserPresets();
  if (!user[oldName] || oldName === newName) return;
  user[newName] = { ...user[oldName], updatedAt: Date.now() };
  delete user[oldName];
  user.__deleted = { ...(user.__deleted || {}), [oldName]: Date.now() };
  await persist();
}
const DEFAULT_GROUP = 'My presets';
/** Move one preset to another category ('' or "My presets" = the default one). */
export async function movePreset(name, group) {
  if (!loaded) await loadUserPresets();
  if (!user[name]) return;
  user[name] = { ...user[name], group: group === DEFAULT_GROUP ? '' : group, updatedAt: Date.now() };
  await persist();
}
/** Rename a category: every preset in it moves to the new name. */
export async function renameGroup(oldName, newName) {
  if (!loaded) await loadUserPresets();
  const to = newName === DEFAULT_GROUP ? '' : newName;
  for (const n of Object.keys(user)) if (n !== '__deleted' && (user[n].group || DEFAULT_GROUP) === oldName) user[n] = { ...user[n], group: to, updatedAt: Date.now() };
  await persist();
}
/** Overwrite a preset with a photo's current settings (name and category stay). */
export async function updatePreset(name, params) {
  if (!loaded) await loadUserPresets();
  if (!user[name]) return;
  user[name] = { ...user[name], patch: snapshotLook(params), mode: 'replace', updatedAt: Date.now() };
  await persist();
}
export async function replaceUserPresets(obj) { user = obj; await persist(); }
export async function mergeUserPresets(obj) {
  if (!loaded) await loadUserPresets();
  user = Object.fromEntries(Object.entries(obj || {}).filter(([n, v]) => n === '__deleted' || validPreset(v)));
  try { await idb.set('kv', 'presets', user); } catch {} bus.emit('presets');
}

// ---------- LUT library ----------
const lutCache = new Map();
export async function listLuts() {
  try { return (await idb.all('luts')).map(([id, v]) => ({ id, name: v.name, size: v.size })); } catch { return []; }
}
export async function saveLut(name, size, data) {
  const id = 'lut' + Date.now().toString(36);
  await idb.set('luts', id, { name, size, data, updatedAt: Date.now() });
  lutCache.set(id, { id, size, data });
  bus.emit('luts');
  return id;
}
export async function deleteLut(id) { lutCache.delete(id); await idb.del('luts', id); bus.emit('luts'); }
export async function getLut(id) {
  if (lutCache.has(id)) return lutCache.get(id);
  const v = await idb.get('luts', id);
  if (!v) return null;
  const l = { id, size: v.size, data: v.data };
  lutCache.set(id, l);
  return l;
}
export async function allLutData() {
  try { return await idb.all('luts'); } catch { return []; }
}
