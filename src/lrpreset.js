// Lightroom preset import / export.
//   .xmp          Lightroom (cloud), Lightroom Classic and Camera Raw presets (crs: settings)
//   .lrtemplate   Lightroom Classic's older Lua-table format
//   .zip          preset packs (any mix of the above, folders become groups)
// A preset only changes the settings it lists. Settings this editor has no equivalent for are reported, not dropped silently.
import { HSL_BANDS, GRADE_ZONES, identityCurves, KEY_DEFAULT } from './params.js';
import { evalCurve } from './curves-math.js';

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];

// crs name -> [our key, scale]; value_ours = value_crs * scale
const SIMPLE = {
  Exposure2012: ['exposure', 1], Contrast2012: ['contrast', 1], Highlights2012: ['highlights', 1], Shadows2012: ['shadows', 1],
  Whites2012: ['whites', 1], Blacks2012: ['blacks', 1], Texture: ['texture', 1], Clarity2012: ['clarity', 1], Dehaze: ['dehaze', 1],
  Vibrance: ['vibrance', 1], Saturation: ['saturation', 1],
  GrainAmount: ['grainAmount', 1], GrainSize: ['grainSize', 1], GrainFrequency: ['grainRoughness', 1],
  PostCropVignetteAmount: ['vigAmount', 1], PostCropVignetteMidpoint: ['vigMidpoint', 1], PostCropVignetteFeather: ['vigFeather', 1], PostCropVignetteRoundness: ['vigRoundness', 1],
  Sharpness: ['sharpAmount', 0.7], SharpenRadius: ['sharpRadius', 1], SharpenEdgeMasking: ['sharpMasking', 1],
  LuminanceSmoothing: ['nrLuma', 1], ColorNoiseReduction: ['nrColor', 1],
  IncrementalTemperature: ['temp', 1], IncrementalTint: ['tint', 100 / 150],
  ColorGradeBlending: ['grade_blend', 1],
  LensManualDistortionAmount: ['distortion', 1], VignetteAmount: ['lensVignette', 1],
  DefringePurpleAmount: ['defringePurple', 5], DefringeGreenAmount: ['defringeGreen', 5],
  AutoLateralCA: ['caRemove', 1],
  ShadowTint: ['calShadowTint', 1],
  RedHue: ['calRedHue', 1], RedSaturation: ['calRedSat', 1], GreenHue: ['calGreenHue', 1], GreenSaturation: ['calGreenSat', 1], BlueHue: ['calBlueHue', 1], BlueSaturation: ['calBlueSat', 1],
  SplitToningBalance: ['grade_balance', 1],
};
// settings we recognise but cannot reproduce
const UNSUPPORTED = [
  [/^LookTable|^Look$|^Look[A-Z]|^Table_|^RGBTable/, 'camera profile / LUT'],
  [/^MaskGroupBasedCorrections$|^GradientBasedCorrections$|^CircularGradientBasedCorrections$|^PaintBasedCorrections$/, 'local adjustments'],
  [/^LensProfile|^LensManualDistortion|^PerspectiveVertical|^PerspectiveHorizontal|^PerspectiveRotate|^PerspectiveScale|^AutoLateralCA|^LensProfileEnable/, 'lens / geometry corrections'],
  [/^RetouchInfo$/, 'spot removal'],
];

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (x) => { const n = parseFloat(String(x).replace(/^\+/, '')); return Number.isFinite(n) ? n : undefined; };
const truthy = (x) => x === true || /^true$/i.test(String(x));

/** Merge a parametric curve (shadows / darks / lights / highlights) into a point curve. */
function foldParametric(points, par) {
  const [sh, da, li, hi] = par.amounts, [s1, s2, s3] = par.splits;
  const bump = (x, a, b) => Math.max(0, 1 - Math.abs(x - (a + b) / 2) / ((b - a) / 2 + 0.0001));
  const para = (x) => {
    const r = [bump(x, 0, s2 * 0.6 + s1 * 0.4 + 0.0001), bump(x, s1 * 0.5, (s1 + s3) / 2 + 0.2 * (s2 - s1)), bump(x, (s1 + s3) / 2 - 0.2 * (s3 - s2), s3 + (1 - s3) * 0.5), bump(x, s3, 1.0001)];
    return x + 0.25 * (sh * r[0] + da * r[1] + li * r[2] + hi * r[3]) / 100;
  };
  const xs = []; for (let i = 0; i <= 16; i++) xs.push(i / 16);
  let ys = xs.map((x) => evalCurve(points, clampTo(para(x), 0, 1)));
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1]);       // keep it monotone
  return xs.map((x, i) => [x, clampTo(ys[i], 0, 1)]);
}
const pointsFrom = (v) => {
  // "x, y" strings, or a flat Lua array [x0, y0, x1, y1, ...]
  const flat = v.length && typeof v[0] === 'string' ? v.flatMap((s) => String(s).split(/[,\s]+/).filter(Boolean).map(Number)) : v.map(Number);
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([clampTo(flat[i] / 255, 0, 1), clampTo(flat[i + 1] / 255, 0, 1)]);
  pts.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of pts) if (!out.length || p[0] > out.at(-1)[0] + 1e-4) out.push(p);
  return out.length >= 2 ? out : null;
};

/** crs settings map (strings / numbers / arrays) -> { patch, ignored: [..] } */
export function crsToPatch(map) {
  const patch = {}, ignored = new Set();
  for (const [k, v] of Object.entries(map)) {
    if (SIMPLE[k]) { const n = num(v); if (n !== undefined) patch[SIMPLE[k][0]] = Math.round(n * SIMPLE[k][1] * 1000) / 1000; continue; }
    for (const [re, label] of UNSUPPORTED) if (re.test(k)) ignored.add(label);
  }
  // HSL / grayscale mixer
  BANDS.forEach((B, i) => {
    const b = HSL_BANDS[i][0];
    for (const [crs, kind] of [['HueAdjustment', 'hue'], ['SaturationAdjustment', 'sat'], ['LuminanceAdjustment', 'lum']]) {
      const n = num(map[crs + B]); if (n !== undefined) patch[`hsl_${b}_${kind}`] = n;
    }
  });
  if (map.ConvertToGrayscale !== undefined) {
    patch.bw = truthy(map.ConvertToGrayscale) ? 1 : 0;
    if (patch.bw) BANDS.forEach((B, i) => { const n = num(map['GrayMixer' + B]); if (n !== undefined) patch[`hsl_${HSL_BANDS[i][0]}_lum`] = n; });
  }
  // colour grading (new) or split toning (old)
  const zones = { Shadow: 'shadow', Midtone: 'mid', Highlight: 'high', Global: 'global' };
  let graded = false;
  for (const [Z, z] of Object.entries(zones)) {
    for (const [crs, kind] of [['Hue', 'hue'], ['Sat', 'sat'], ['Lum', 'lum']]) {
      const n = num(map[`ColorGrade${Z}${crs}`]); if (n !== undefined) { patch[`grade_${z}_${kind}`] = n; graded = true; }
    }
  }
  if (!graded) {
    for (const [crs, z] of [['Shadow', 'shadow'], ['Highlight', 'high']]) {
      const h = num(map[`SplitToning${crs}Hue`]), s = num(map[`SplitToning${crs}Saturation`]);
      if (h !== undefined) patch[`grade_${z}_hue`] = h;
      if (s !== undefined) patch[`grade_${z}_sat`] = s;
    }
  }
  // tone curves
  const curves = {};
  const cm = { ToneCurvePV2012: 'rgb', ToneCurvePV2012Red: 'r', ToneCurvePV2012Green: 'g', ToneCurvePV2012Blue: 'b' };
  for (const [crs, ch] of Object.entries(cm)) if (Array.isArray(map[crs])) { const p = pointsFrom(map[crs]); if (p) curves[ch] = p; }
  const pv = ['Shadows', 'Darks', 'Lights', 'Highlights'].map((n) => num(map['Parametric' + n]) || 0);
  if (pv.some((x) => x)) {
    const sp = ['ParametricShadowSplit', 'ParametricMidtoneSplit', 'ParametricHighlightSplit'].map((n, i) => (num(map[n]) ?? [25, 50, 75][i]) / 100);
    curves.rgb = foldParametric(curves.rgb || [[0, 0], [1, 1]], { amounts: pv, splits: sp });
  }
  if (Object.keys(curves).length) patch.curves = curves;
  return { patch, ignored: [...ignored] };
}

// ---------- XMP ----------
export function parseXmp(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid XMP file');
  const descs = [...doc.getElementsByTagNameNS(RDF, 'Description')];
  if (!descs.length) throw new Error('No settings found in this file');
  const map = {};
  let name = '', group = '';
  for (const d of descs) {
    for (const a of d.attributes) if (a.namespaceURI === CRS) map[a.localName] = a.value;
    for (const c of d.children) {
      if (c.namespaceURI !== CRS) continue;
      const li = [...c.getElementsByTagNameNS(RDF, 'li')].map((x) => x.textContent.trim());
      const isSeq = c.getElementsByTagNameNS(RDF, 'Seq').length > 0;
      if (c.localName === 'Name') name = li[0] || '';
      else if (c.localName === 'Group') group = li[0] || '';
      else if (isSeq) map[c.localName] = li;
      else if (c.children.length === 0) map[c.localName] = c.textContent.trim();
      else map[c.localName] = li;     // nested structures (masks, retouch…): only the key matters
    }
  }
  if (!name) name = map.ShortName || '';
  const { patch, ignored } = crsToPatch(map);
  return { name, group: group || map.Cluster || '', patch, ignored, hasAmount: truthy(map.SupportsAmount) };
}

// ---------- .lrtemplate (Lua table) ----------
function parseLua(src) {
  let i = 0;
  const ws = () => { for (;;) { while (i < src.length && /\s/.test(src[i])) i++; if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i++; } else break; } };
  const str = () => {
    const q = src[i++]; let out = '';
    while (i < src.length && src[i] !== q) { if (src[i] === '\\') { i++; out += { n: '\n', t: '\t' }[src[i]] ?? src[i]; } else out += src[i]; i++; }
    i++; return out;
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    const m = /^(-?\d+\.?\d*(?:[eE][+-]?\d+)?|true|false|nil)/.exec(src.slice(i, i + 40));
    if (m) { i += m[0].length; return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : parseFloat(m[0]); }
    throw new Error('Unexpected content in .lrtemplate');
  };
  const table = () => {
    i++; const obj = {}, arr = []; let keyed = false;
    for (;;) {
      ws();
      if (src[i] === '}') { i++; break; }
      let key = null;
      if (src[i] === '[') { i++; ws(); key = value(); ws(); i++; ws(); i++; }       // ["key"] =
      else { const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(src.slice(i, i + 80)); if (m) { key = m[1]; i += m[0].length; } }
      const v = value();
      if (key !== null) { obj[key] = v; keyed = true; } else arr.push(v);
      ws(); if (src[i] === ',' || src[i] === ';') i++;
    }
    return keyed ? obj : arr;
  };
  ws();
  const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/.exec(src.slice(i, i + 80));
  if (m) i += m[0].length;
  return value();
}
export function parseLrTemplate(text) {
  const t = parseLua(text);
  const settings = t?.value?.settings;
  if (!settings) throw new Error('No develop settings found in this .lrtemplate');
  const map = {};
  for (const [k, v] of Object.entries(settings)) map[k] = v;
  const { patch, ignored } = crsToPatch(map);
  return { name: t.title || t.internalName || '', group: '', patch, ignored, hasAmount: true };
}

/** Parse any supported preset file's text. */
export function parsePresetText(filename, text) {
  const ext = filename.toLowerCase().replace(/^.*\./, '');
  const r = ext === 'lrtemplate' ? parseLrTemplate(text) : parseXmp(text);
  if (!r.name) r.name = filename.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  return r;
}

// ---------- export ----------
const BY_OURS = Object.fromEntries(Object.entries(SIMPLE).map(([crs, [ours, scale]]) => [ours, [crs, scale]]));
const signed = (n, dec) => (n > 0 ? '+' : '') + n.toFixed(dec);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').toUpperCase().slice(0, 32);

/** params: full or partial parameter object (only non-default values are written). */
export function toXmp(name, params, { group = '' } = {}) {
  const attrs = [];
  const add = (k, v) => attrs.push(`   crs:${k}="${v}"`);
  for (const [ours, [crs, scale]] of Object.entries(BY_OURS)) {
    const v = params[ours];
    if (v === undefined || v === KEY_DEFAULT[ours]) continue;
    const n = v / scale;
    const dec = crs === 'Exposure2012' || crs === 'SharpenRadius' ? 2 : 0;
    if (crs === 'SharpenRadius') add(crs, n.toFixed(1));
    else add(crs, ['Exposure2012', 'IncrementalTemperature', 'IncrementalTint'].includes(crs) || dec ? signed(n, dec) : /^(Sharpness|Grain|PostCropVignetteM|PostCropVignetteF|LuminanceS|ColorNoise|ColorGradeBl|Defringe|AutoLateralCA)/.test(crs) ? String(Math.round(n)) : signed(Math.round(n), 0));
  }
  BANDS.forEach((B, i) => {
    const b = HSL_BANDS[i][0];
    for (const [crs, kind] of [['HueAdjustment', 'hue'], ['SaturationAdjustment', 'sat'], ['LuminanceAdjustment', 'lum']]) {
      const v = params[`hsl_${b}_${kind}`];
      if (v) add(crs + B, signed(v, 0));
    }
    if (params.bw) { const v = params[`hsl_${b}_lum`]; if (v) add('GrayMixer' + B, signed(v, 0)); }
  });
  if (params.bw) add('ConvertToGrayscale', 'True');
  for (const [Z, z] of [['Shadow', 'shadow'], ['Midtone', 'mid'], ['Highlight', 'high'], ['Global', 'global']]) {
    for (const [crs, kind] of [['Hue', 'hue'], ['Sat', 'sat'], ['Lum', 'lum']]) {
      const v = params[`grade_${z}_${kind}`];
      if (v) add(`ColorGrade${Z}${crs}`, kind === 'lum' ? signed(v, 0) : String(Math.round(v)));
    }
  }
  const curveXml = [];
  if (params.curves) {
    for (const [ch, crs] of [['rgb', 'ToneCurvePV2012'], ['r', 'ToneCurvePV2012Red'], ['g', 'ToneCurvePV2012Green'], ['b', 'ToneCurvePV2012Blue']]) {
      const c = params.curves[ch];
      if (!c || (c.length === 2 && c[0][1] === 0 && c[1][1] === 1)) continue;
      curveXml.push(`   <crs:${crs}>\n    <rdf:Seq>\n${c.map(([x, y]) => `     <rdf:li>${Math.round(x * 255)}, ${Math.round(y * 255)}</rdf:li>`).join('\n')}\n    </rdf:Seq>\n   </crs:${crs}>`);
    }
  }
  const nm = esc(name);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00">
 <rdf:RDF xmlns:rdf="${RDF}">
  <rdf:Description rdf:about=""
   xmlns:crs="${CRS}"
   crs:PresetType="Normal"
   crs:Cluster=""
   crs:UUID="${uuid()}"
   crs:SupportsAmount="True"
   crs:SupportsColor="True"
   crs:SupportsMonochrome="True"
   crs:SupportsHighDynamicRange="True"
   crs:SupportsNormalDynamicRange="True"
   crs:SupportsSceneReferred="True"
   crs:SupportsOutputReferred="True"
   crs:RequiresRGBTables="False"
   crs:CameraModelRestriction=""
   crs:Copyright=""
   crs:ContactInfo=""
   crs:Version="15.0"
   crs:ProcessVersion="11.0"
${attrs.join('\n')}>
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${nm}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:ShortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${nm}</rdf:li>
    </rdf:Alt>
   </crs:ShortName>
   <crs:SortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${nm}</rdf:li>
    </rdf:Alt>
   </crs:SortName>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(group || 'User Presets')}</rdf:li>
    </rdf:Alt>
   </crs:Group>
   <crs:Description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default"/>
    </rdf:Alt>
   </crs:Description>
${curveXml.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export { identityCurves };
