// Edit model: global parameters, masks and crop, plus the tables the UI is generated from.

export const HSL_BANDS = [
  ['red', 'Red', '#e5484d'], ['orange', 'Orange', '#f2842b'], ['yellow', 'Yellow', '#e8c32a'], ['green', 'Green', '#3dba5a'],
  ['aqua', 'Aqua', '#2cc3c3'], ['blue', 'Blue', '#3b82f6'], ['purple', 'Purple', '#8b5cf6'], ['magenta', 'Magenta', '#d946a8'],
];
// hue centre (degrees) of each band, matching the shader
export const BAND_HUE = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 270, magenta: 300 };
export const HSL_KINDS = [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']];
export const GRADE_ZONES = [['shadow', 'Shadows'], ['mid', 'Midtones'], ['high', 'Highlights'], ['global', 'Global']];

// [key, label, min, max, step, section, sub, default]
// Everything is -100..100 like Lightroom, except where noted.
export const PARAMS = [
  ['exposure', 'Exposure', -5, 5, 0.01, 'light', '', 0],
  ['contrast', 'Contrast', -100, 100, 1, 'light', '', 0],
  ['highlights', 'Highlights', -100, 100, 1, 'light', '', 0],
  ['shadows', 'Shadows', -100, 100, 1, 'light', '', 0],
  ['whites', 'Whites', -100, 100, 1, 'light', '', 0],
  ['blacks', 'Blacks', -100, 100, 1, 'light', '', 0],

  ['temp', 'Temp', -100, 100, 1, 'color', '', 0],
  ['tint', 'Tint', -100, 100, 1, 'color', '', 0],
  ['vibrance', 'Vibrance', -100, 100, 1, 'color', '', 0],
  ['saturation', 'Saturation', -100, 100, 1, 'color', '', 0],

  ['texture', 'Texture', -100, 100, 1, 'effects', '', 0],
  ['clarity', 'Clarity', -100, 100, 1, 'effects', '', 0],
  ['dehaze', 'Dehaze', -100, 100, 1, 'effects', '', 0],
  ['vigAmount', 'Amount', -100, 100, 1, 'effects', 'Vignette', 0],
  ['vigMidpoint', 'Midpoint', 0, 100, 1, 'effects', 'Vignette', 50],
  ['vigRoundness', 'Roundness', -100, 100, 1, 'effects', 'Vignette', 0],
  ['vigFeather', 'Feather', 0, 100, 1, 'effects', 'Vignette', 50],
  ['grainAmount', 'Amount', 0, 100, 1, 'effects', 'Grain', 0],
  ['grainSize', 'Size', 0, 100, 1, 'effects', 'Grain', 25],
  ['grainRoughness', 'Roughness', 0, 100, 1, 'effects', 'Grain', 50],

  ['sharpAmount', 'Amount', 0, 100, 1, 'detail', 'Sharpening', 0],
  ['sharpRadius', 'Radius', 0.5, 3, 0.1, 'detail', 'Sharpening', 1],
  ['sharpMasking', 'Masking', 0, 100, 1, 'detail', 'Sharpening', 0],
  ['nrLuma', 'Luminance', 0, 100, 1, 'detail', 'Noise reduction', 0],
  ['nrColor', 'Color', 0, 100, 1, 'detail', 'Noise reduction', 0],

  ['caRemove', 'Remove color fringing', 0, 1, 1, 'optics', '', 0],           // checkbox
  ['defringePurple', 'Defringe: purple', 0, 100, 1, 'optics', '', 0],
  ['defringeGreen', 'Defringe: green', 0, 100, 1, 'optics', '', 0],
  ['caRed', 'Chromatic aberration: red / cyan', -100, 100, 1, 'optics', '', 0],
  ['caBlue', 'Chromatic aberration: blue / yellow', -100, 100, 1, 'optics', '', 0],
  ['distortion', 'Distortion', -100, 100, 1, 'optics', '', 0],
  ['lensVignette', 'Vignetting', -100, 100, 1, 'optics', '', 0],

  // Calibration: adjusts the camera's colour primaries, applied before everything else
  ['calShadowTint', 'Tint', -100, 100, 1, 'calibration', 'Shadows', 0],
  ['calRedHue', 'Hue', -100, 100, 1, 'calibration', 'Red primary', 0],
  ['calRedSat', 'Saturation', -100, 100, 1, 'calibration', 'Red primary', 0],
  ['calGreenHue', 'Hue', -100, 100, 1, 'calibration', 'Green primary', 0],
  ['calGreenSat', 'Saturation', -100, 100, 1, 'calibration', 'Green primary', 0],
  ['calBlueHue', 'Hue', -100, 100, 1, 'calibration', 'Blue primary', 0],
  ['calBlueSat', 'Saturation', -100, 100, 1, 'calibration', 'Blue primary', 0],
];

// HSL (Color Mix): hsl_<band>_<hue|sat|lum>
export const HSL_PARAMS = HSL_BANDS.flatMap(([b, label]) =>
  HSL_KINDS.map(([k]) => [`hsl_${b}_${k}`, label, -100, 100, 1, 'color', 'Color mix', 0]));

// Color grading: grade_<zone>_hue (0..360), _sat (0..100), _lum (-100..100) + blending / balance
export const GRADE_PARAMS = [
  ...GRADE_ZONES.flatMap(([z, label]) => [
    [`grade_${z}_hue`, `${label} hue`, 0, 360, 1, 'color', 'Color grading', 0],
    [`grade_${z}_sat`, `${label} saturation`, 0, 100, 1, 'color', 'Color grading', 0],
    [`grade_${z}_lum`, `${label} luminance`, -100, 100, 1, 'color', 'Color grading', 0],
  ]),
  ['grade_blend', 'Blending', 0, 100, 1, 'color', 'Color grading', 50],
  ['grade_balance', 'Balance', -100, 100, 1, 'color', 'Color grading', 0],
];

export const ALL_PARAMS = [...PARAMS, ...HSL_PARAMS, ...GRADE_PARAMS];
export const KEY_DEFAULT = Object.fromEntries(ALL_PARAMS.map((p) => [p[0], p[7]]));

export const SECTIONS = [
  ['light', 'Light', true],
  ['color', 'Color', true],
  ['grading', 'Color grading', false],
  ['curves', 'Curves', false],
  ['effects', 'Effects', false],
  ['detail', 'Detail', false],
  ['optics', 'Optics', false],
  ['calibration', 'Calibration', false],
];

// Per-mask local adjustments (same maths as the global ones)
export const MASK_ADJ = [
  ['exposure', 'Exposure', -5, 5, 0.01],
  ['contrast', 'Contrast', -100, 100, 1],
  ['highlights', 'Highlights', -100, 100, 1],
  ['shadows', 'Shadows', -100, 100, 1],
  ['whites', 'Whites', -100, 100, 1],
  ['blacks', 'Blacks', -100, 100, 1],
  ['temp', 'Temp', -100, 100, 1],
  ['tint', 'Tint', -100, 100, 1],
  ['vibrance', 'Vibrance', -100, 100, 1],
  ['saturation', 'Saturation', -100, 100, 1],
];

export const MAX_MASKS = 8;
export const MAX_BRUSH_MASKS = 4;     // brush components across the whole photo (one GPU layer each)
export const MAX_COMPS = 4;           // components per mask

export const identityCurves = () => ({ rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });

export const defaults = () => ({
  ...KEY_DEFAULT,
  bw: 0,
  profile: '',      // '' | 'b:<built-in look>' | 'l:<lut id>' (what the Profile dropdown shows)
  baseProfile: '',  // RAW only: '' = Adobe Color | 'camera' | 'neutral' | 'vivid' | 'landscape' | 'portrait'
  lut: null,        // id of a LUT from the looks library
  lutAmount: 100,
  curves: identityCurves(),
});

export const defaultAdj = () => Object.fromEntries(MASK_ADJ.map(([k]) => [k, 0]));
// local detail sliders (applied in the finish pass, added to the global ones): -100..100, sharpness 0..100
export const MASK_DETAIL = [['texture', 'Texture', -100, 100, 1], ['clarity', 'Clarity', -100, 100, 1], ['dehaze', 'Dehaze', -100, 100, 1], ['sharpness', 'Sharpness', 0, 100, 1]];
export const defaultDetail = () => Object.fromEntries(MASK_DETAIL.map(([k]) => [k, 0]));

let seq = 1;
const uid = (p) => p + Date.now().toString(36) + (seq++);
/**
 * A mask is a list of components combined with add / subtract / intersect, plus the adjustments it applies.
 * Component geometry lives in "height units": the source image is aspect x 1 (height = 1), origin top-left.
 *   linear:  geo = { x0, y0, x1, y1 }                full effect at (x0,y0) fading to none at (x1,y1)
 *   radial:  geo = { cx, cy, rx, ry, angle }         angle in radians
 *   brush:   strokes = [{ size, feather, flow, erase, pts: [[x, y], ...] }]
 *   lum:     range = { lo, hi, smooth }              luminance range, 0..1
 *   color:   range = { hue (0..360), range (0..1), satMin (0..1), smooth }
 */
export function newComp(type, geo = {}) {
  const c = { id: uid('c'), type, op: 'add', invert: false, feather: type === 'radial' ? 0.5 : 1, geo, strokes: [], rev: 0 };
  if (type === 'lum') c.range = { lo: 0, hi: 0.4, smooth: 0.15 };
  if (type === 'color') c.range = { hue: 0, range: 0.3, satMin: 0.12, smooth: 0.3 };
  return c;
}
export function newMask(type, geo = {}) {
  return { id: uid('m'), name: '', enabled: true, adj: defaultAdj(), detail: defaultDetail(), comps: [newComp(type, geo)] };
}
/** Older saves stored a single component on the mask itself. */
export function migrateMask(m) {
  if (!m.comps) {
    m.comps = [{ id: 'c' + m.id, type: m.type, op: 'add', invert: !!m.invert, feather: m.feather ?? 1, geo: m.geo || {}, strokes: m.strokes || [], rev: m.rev || 0 }];
    delete m.type; delete m.invert; delete m.feather; delete m.geo; delete m.strokes; delete m.rev;
  }
  m.detail = { ...defaultDetail(), ...(m.detail || {}) };
  m.adj = { ...defaultAdj(), ...(m.adj || {}) };
  if (m.enabled === undefined) m.enabled = true;
  for (const c of m.comps) { c.rev = c.rev || 0; c.strokes = c.strokes || []; c.op = c.op || 'add'; }
  return m;
}
export const maskIsEmpty = (m) => Object.values(m.adj).every((v) => v === 0) && Object.values(m.detail || {}).every((v) => v === 0);

export const defaultCrop = () => ({ angle: 0, rot90: 0, flipH: false, flipV: false, rect: null, aspect: 'orig' });

export const clone = (o) => JSON.parse(JSON.stringify(o));
