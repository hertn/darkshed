// Renderer.
//   pass 1 (edit):   source (linear) -> tone / masks / curves / HSL / grading / LUT -> RGBA8 sRGB framebuffer, in SOURCE space
//   pass 2 (finish): framebuffer -> geometry (crop/rotate/flip) + noise reduction, sharpening, texture, clarity, dehaze,
//                    vignette, grain, mask overlay -> canvas (with zoom / pan)
// Pass 1 can render any horizontal region of the image, which is how full-resolution export works in strips.

import { HSL_BANDS, GRADE_ZONES, MAX_MASKS, MAX_BRUSH_MASKS, MAX_COMPS, identityCurves } from './params.js';
import { TUNE, rawCamStops, rawCamCurve } from './tuning.js';
const colMajor = (k) => [k[0], k[3], k[6], k[1], k[4], k[7], k[2], k[5], k[8]];   // rows -> GL's column order
import { evalCurve, curvesActive, curveIsIdentity } from './curves-math.js';

export { evalCurve, curvesActive, curveIsIdentity };

const VERT_EDIT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const VERT_VIEW = `#version 300 es
in vec2 aPos;
uniform vec2 uFit;
uniform float uZoom;
uniform vec2 uPan;
uniform vec2 uBand;       // exports draw one band of rows at a time: first row (0..1 of the output height) and share of the height
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = uBand.x + (1.0 - vUv.y) * uBand.y;
  gl_Position = vec4(aPos * uFit * uZoom + uPan, 0.0, 1.0);
}`;

// Shared by both fragment shaders. A mask is up to 4 components combined with add / subtract / intersect.
// Geometry is in height units (source = aspect x 1). Component types: 1 linear, 2 radial, 3 brush, 4 luminance range, 5 colour range.
const MASK_FN = `
precision highp sampler2DArray;
uniform vec4 uCGeo1[32];
uniform vec4 uCGeo2[32];
uniform vec4 uCInfo[32];    // type, op (0 add, 1 subtract, 2 intersect), invert, feather
uniform vec4 uMInfo[8];     // x = number of components (0 = mask unused)
uniform sampler2DArray uBrush;

vec2 hueSat(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  float h = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec2(h, mx > 1e-5 ? d / mx : 0.0);
}

float compWeight(int ci, vec2 p, vec2 layerUv, vec3 col) {
  vec4 g1 = uCGeo1[ci];
  vec4 g2 = uCGeo2[ci];
  vec4 info = uCInfo[ci];
  int type = int(info.x + 0.5);
  float w = 0.0;
  if (type == 1) {
    vec2 a = g1.xy;
    vec2 d = g1.zw - g1.xy;
    float t = dot(p - a, d) / max(dot(d, d), 1e-8);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (type == 2) {
    vec2 q = p - g1.xy;
    float ca = cos(g2.x), sa = sin(g2.x);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    q /= max(g1.zw, vec2(1e-4));
    float inner = min(1.0 - info.w, 0.995);
    w = 1.0 - smoothstep(inner, 1.0, length(q));
  } else if (type == 3) {
    w = texture(uBrush, vec3(layerUv, g2.w)).r;
  } else if (type == 4) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float sm = max(g1.z, 0.005);
    w = smoothstep(g1.x - sm, g1.x, l) * (1.0 - smoothstep(g1.y, g1.y + sm, l));
  } else if (type == 5) {
    vec2 hs = hueSat(clamp(col, 0.0, 1.0));
    float d = abs(fract(hs.x - g1.x + 0.5) - 0.5);          // hue distance in turns
    float hw = max(g1.y * 0.5, 0.01);
    float sm = max(g1.w * hw, 0.01);
    w = (1.0 - smoothstep(hw - sm, hw + sm, d)) * smoothstep(g1.z - 0.06, g1.z + 0.06, hs.y);
  }
  return info.z > 0.5 ? 1.0 - w : w;
}

float maskWeight(int i, vec2 p, vec2 layerUv, vec3 col) {
  int n = int(uMInfo[i].x + 0.5);
  float w = 0.0;
  for (int j = 0; j < 4; j++) {
    if (j >= n) break;
    int ci = i * 4 + j;
    float wc = compWeight(ci, p, layerUv, col);
    int op = int(uCInfo[ci].y + 0.5);
    if (j == 0) w = wc;
    else if (op == 0) w = w + wc - w * wc;
    else if (op == 1) w = w * (1.0 - wc);
    else w = w * wc;
  }
  return w;
}`;

const FRAG_EDIT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uTex;
uniform sampler2D uCurve;
uniform sampler3D uLut;
uniform vec2 uImgPx;        // size of the image coordinate space (px)
uniform vec4 uRegion;       // x, y, w, h of the rendered region (px)
uniform vec2 uTexOrigin;    // where the source texture sits in image px
uniform vec2 uTexSize;
uniform vec4 uGA, uGB, uGC; // global: (exposure,contrast,highlights,shadows) (whites,blacks,temp,tint) (vibrance,saturation)
uniform vec4 uMA[8];
uniform vec4 uMB[8];
uniform vec4 uMC[8];
uniform vec3 uHsl[8];
uniform vec3 uGrd[4];       // shadow, mid, high, global: (hue 0..1, sat 0..1, lum -1..1)
uniform vec2 uGrdBB;        // blending, balance
uniform vec4 uTn;           // slider strengths (see tuning.js): wb temp, wb tint, highlights, highlights start
uniform float uGrdK;
uniform vec4 uGt;           // grading: luminance strength, zone falloff at blending 0 and 100
uniform vec2 uMk;           // shadow/highlight mask: share of the brightest channel (vs luma); white balance: share of luminance kept constant
uniform mat3 uWmT, uWmN;    // white balance matrices at temperature +25 and tint +20
uniform float uPPc;         // share of the tone curve done in ProPhoto primaries
uniform bool uRawOn;        // RAW file: Lightroom's camera-profile base curve replaces the plain sRGB encode
uniform vec3 uRB[25];
uniform vec2 uRBx;          // log2 of the first knot, stops between knots
vec3 baseEnc(vec3 c) {
  vec3 x = clamp((log2(max(c, vec3(1e-6))) - uRBx.x) / uRBx.y, 0.0, 23.999);
  vec3 r;
  for (int k = 0; k < 3; k++) {
    int i = int(x[k]); float f = x[k] - float(i);
    r[k] = mix(uRB[i][k], uRB[i + 1][k], f);
  }
  return r;
}
uniform float uPPe;         // 1 = exposure stage in ProPhoto
uniform float uCtP;         // contrast pivot warp (1 = pivot at mid-grey)
uniform float uKnee;        // exposure highlight roll-off starts here (linear)
uniform vec2 uWf;           // white balance fade towards the highlights: amount, start brightness
uniform vec4 uTn4;          // vibrance, saturation strength
uniform vec4 uTn2;          // exposure, contrast, shadows, shadows range
uniform vec4 uTn3;          // whites, blacks, highlights fade-out, shadows lift
uniform float uLutAmt, uLutSize, uLensVig, uCalTint;
uniform mat3 uCalM;
uniform bool uCalOn;
uniform bool uHslOn, uCurveOn, uGrdOn, uLutOn, uBw, uBypass;
in vec2 vUv;
out vec4 o;
${MASK_FN}

uniform float CEN[8];       // hue centre of each HSL band (degrees)
uniform vec4 uHk;           // HSL: hue degrees at 100, saturation, luminance strength, window shape (0 = triangle, 1 = smooth)

vec3 enc(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 dec(vec3 p) {
  p = clamp(p, 0.0, 1.0);
  return mix(p / 12.92, pow((p + 0.055) / 1.055, vec3(2.4)), step(0.04045, p));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
uniform bool uRawCc;
uniform vec3 uRawCcK[17];   // per-camera correction after the base curve
vec3 camCurve(vec3 p) {
  vec3 x = clamp(p, 0.0, 1.0) * 16.0, r;
  for (int k = 0; k < 3; k++) {
    int i = min(int(x[k]), 15); float f = x[k] - float(i);
    r[k] = mix(uRawCcK[i][k], uRawCcK[i + 1][k], f);
  }
  return r + (p - clamp(p, 0.0, 1.0));
}
uniform float uRawOff;       // RAW: camera brightness offset in stops
uniform vec2 uRawHl;        // RAW highlights: stops at +100 / -100 (tuning.js)
const float HLX[9] = float[9](0.0, 0.04, 0.10, 0.15, 0.20, 0.27, 0.35, 0.44, 1.0);
const float HLY[9] = float[9](0.0, 0.0, 0.10, 0.28, 0.39, 0.49, 0.63, 1.0, 1.1);
// RAW highlights work on the picture after the base curve: a smooth lift that grows with brightness (measured on Lightroom exports)
vec3 hlRaw(vec3 pe, float v) {
  float l = clamp(luma(pe), 0.0, 1.0), m = 0.0;
  for (int i = 0; i < 8; i++) if (l >= HLX[i]) m = mix(HLY[i], HLY[i + 1], clamp((l - HLX[i]) / (HLX[i + 1] - HLX[i]), 0.0, 1.0));
  return enc(max(dec(max(pe, 0.0)) * exp2(v * m * (v > 0.0 ? uRawHl.x : uRawHl.y)), 0.0));
}

vec3 rgb2hsv(vec3 c) {
  vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
}
float curveAt(float v, int ch) {
  vec4 t = texture(uCurve, vec2(clamp(v, 0.0, 1.0) * 0.99609375 + 0.001953125, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}

// white balance matrix for a slider position: the colour change Lightroom makes at +25 temperature / +20 tint (uWmT, uWmN),
// scaled to the slider (gains follow a power law, the cross-channel terms scale linearly)
mat3 wbMat(mat3 K, float t) {
  vec3 d = vec3(K[0][0], K[1][1], K[2][2]);
  return mat3(pow(d.x, t), 0.0, 0.0, 0.0, pow(d.y, t), 0.0, 0.0, 0.0, pow(d.z, t)) + (K - mat3(d.x, 0.0, 0.0, 0.0, d.y, 0.0, 0.0, 0.0, d.z)) * t;
}
const mat3 TOPP = mat3(0.529346, 0.098374, 0.016883, 0.330073, 0.873461, 0.117672, 0.140581, 0.028165, 0.865444);
const mat3 FROMPP = mat3(2.034076, -0.228813, -0.008570, -0.727334, 1.231730, -0.153287, -0.306742, -0.002917, 1.161856);
// linear-light part of an adjustment set: white balance, exposure (+ highlight shoulder), shadows / highlights
vec3 toneLin(vec3 c, vec4 A, vec4 B) {
  float wf = 1.0 - uWf.x * smoothstep(uWf.y, 1.0, luma(enc(c)));
  mat3 wm = wbMat(uWmT, B.z * 4.0 * wf) * wbMat(uWmN, B.w * 5.0 * wf);
  wm /= mix(1.0, luma(wm * vec3(1.0)), uMk.y);
  c = wm * c;
  if (uPPe > 0.5) c = TOPP * c;                        // exposure and its highlight roll-off work in ProPhoto, as in Lightroom
  float ex = A.x * uTn2.x;
  float W = exp2(max(ex, 0.0)) * mix(1.0, max(1.0, max(wm[0][0] + wm[1][0] + wm[2][0], max(wm[0][1] + wm[1][1] + wm[2][1], wm[0][2] + wm[1][2] + wm[2][2]))), uTn4.z);
  c *= exp2(ex);
  float KNEE = uKnee;
  float a = (W - 1.0) / (1.0 - KNEE);
  vec3 t = clamp((c - KNEE) / max(W - KNEE, 1e-4), 0.0, 1.0);
  vec3 sh = KNEE + (1.0 - KNEE) * t * (1.0 + a) / (1.0 + a * t);
  c = mix(c, sh, step(KNEE, c));
  if (uPPe > 0.5) c = max(FROMPP * c, 0.0);
  vec3 ec = enc(c);
  float le = mix(luma(ec), max(ec.r, max(ec.g, ec.b)), uMk.x);
  float ms = 1.0 - smoothstep(0.0, uTn2.w, le);
  float mh = smoothstep(uTn.w, 1.0, le) * (1.0 - smoothstep(uTn3.z, 1.0, le));
  c *= exp2(A.w * uTn2.z * ms);
  c += max(A.w, 0.0) * uTn3.w * ms * smoothstep(0.0, 0.003, le);
  if (!uRawOn) c *= exp2(A.z * uTn.z * mh);
  return c;
}
// display-referred part: blacks / whites, contrast
vec3 toneEnc(vec3 p, vec4 A, vec4 B) {
  float bp = -B.y * uTn3.y;
  float wp = 1.0 - B.x * uTn3.x;
  p = (p - bp) / max(wp - bp, 0.05);
  vec3 q = clamp(p, 0.0, 1.0);
  vec3 qw = pow(q, vec3(uCtP));                       // pivot of the contrast curve: below 1 moves it under mid-grey
  vec3 sc = pow(qw * qw * (3.0 - 2.0 * qw), vec3(1.0 / uCtP));
  float ct = A.y * uTn2.y;
  return ct >= 0.0 ? mix(p, sc, ct) : mix(p, vec3(0.5), -ct * 0.5);
}
vec3 colorAdj(vec3 p, vec4 C) {
  float lm = luma(p);
  float mx = max(p.r, max(p.g, p.b));
  float mn = min(p.r, min(p.g, p.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  float k = max(1.0 + C.y * uTn4.y + C.x * uTn4.x * (1.0 - sat), 0.0);
  vec3 lp = dec(clamp(p, 0.0, 1.0));                  // Lightroom scales colour in linear light, around the luma
  float ll = luma(lp);
  return mix(p, enc(max(ll + (lp - ll) * k, 0.0)), uTn4.w);
}

vec3 grade(vec3 p) {
  float l = luma(clamp(p, 0.0, 1.0));
  float l2 = clamp(l + uGrdBB.y * 0.4, 0.0, 1.0);
  float k = mix(uGt.y, uGt.z, uGrdBB.x);
  float w[4];
  w[0] = pow(1.0 - l2, k);
  w[1] = pow(max(1.0 - abs(2.0 * l2 - 1.0), 0.0), k);
  w[2] = pow(l2, k);
  w[3] = 1.0;
  float gl0 = clamp(luma(p), 0.0, 1.0);
  float edge = smoothstep(0.0, max(uGt.w, 1e-4), gl0) * smoothstep(0.0, max(uGt.w, 1e-4), 1.0 - gl0);
  for (int i = 0; i < 4; i++) {
    vec3 g = uGrd[i];
    vec3 tint = hsv2rgb(vec3(g.x, 1.0, 1.0));
    p += (tint - luma(tint)) * g.y * w[i] * uGrdK * edge;
    p += g.z * w[i] * uGt.x;
  }
  return p;
}

void main() {
  vec2 px = uRegion.xy + gl_FragCoord.xy;           // image px of this fragment (row 0 = top)
  vec3 c = texture(uTex, (px - uTexOrigin) / uTexSize).rgb;
  if (uBypass) { o = vec4(enc(c), 1.0); return; }
  vec2 hp = px / uImgPx.y;                           // height units, for mask geometry
  if (uLensVig != 0.0) {                             // lens vignetting correction: gain grows with distance from the centre
    vec2 ctr = vec2(uImgPx.x / uImgPx.y * 0.5, 0.5);
    c *= exp2(uLensVig * 1.6 * dot(hp - ctr, hp - ctr) / dot(ctr, ctr));
  }
  vec2 layerUv = gl_FragCoord.xy / uRegion.zw;

  if (uCalOn) {                                      // calibration: new colour primaries, then a tint confined to the shadows
    c = max(uCalM * c, 0.0);
    float sh = 1.0 - smoothstep(0.0, 0.18, luma(c));
    c.g *= exp2(-uCalTint * 0.6 * sh);
  }
  if (uRawOn) c *= exp2(uRawOff);
  c = toneLin(c, uGA, uGB);
  vec3 p = uRawOn ? hlRaw(uRawCc ? camCurve(baseEnc(c)) : baseEnc(c), uGA.z) : enc(c);
  p = toneEnc(p, uGA, uGB);

  // local adjustments
  for (int i = 0; i < 8; i++) {
    if (uMInfo[i].x < 0.5) continue;
    float w = maskWeight(i, hp, layerUv, p);
    if (w < 0.002) continue;
    vec3 cl = toneLin(dec(p), uMA[i], uMB[i]);
    vec3 pl = colorAdj(toneEnc(enc(cl), uMA[i], uMB[i]), uMC[i]);
    if (uRawOn) pl = hlRaw(pl, uMA[i].z);
    p = mix(p, pl, w);
  }

  if (uCurveOn) {
    vec3 pc = clamp(p, 0.0, 1.0);
    vec3 srgb = vec3(curveAt(pc.r, 0), curveAt(pc.g, 1), curveAt(pc.b, 2));
    // Lightroom runs its curves per channel in ProPhoto primaries (with the sRGB transfer curve), which is what makes saturated colours behave differently
    vec3 qc = clamp(enc(max(TOPP * dec(pc), 0.0)), 0.0, 1.0);
    vec3 pp = enc(max(FROMPP * dec(vec3(curveAt(qc.r, 0), curveAt(qc.g, 1), curveAt(qc.b, 2))), 0.0));
    p = mix(srgb, pp, uPPc);
  }
  p = colorAdj(p, uGC);

  // HSL: 8 bands with triangular hue windows that sum to 1 everywhere on the wheel
  if (uHslOn) {
    vec3 hsv = rgb2hsv(clamp(p, 0.0, 1.0));
    float h = hsv.x * 360.0;
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 8; i++) {
      float cc = CEN[i];
      float prevC = i == 0 ? CEN[7] - 360.0 : CEN[i - 1];
      float nextC = i == 7 ? CEN[0] + 360.0 : CEN[i + 1];
      float d = h - cc;
      if (d > 180.0) d -= 360.0;
      if (d < -180.0) d += 360.0;
      float width = d >= 0.0 ? nextC - cc : cc - prevC;
      float wt = max(0.0, 1.0 - abs(d) / width);
      wt = mix(wt, wt * wt * (3.0 - 2.0 * wt), uHk.w);
      dh += wt * uHsl[i].x; ds += wt * uHsl[i].y; dl += wt * uHsl[i].z;
    }
    float sw = smoothstep(0.02, 0.2, hsv.y);
    hsv.x = fract(hsv.x + dh * uHk.x / 360.0 * sw + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + ds * uHk.y * sw), 0.0, 1.0);
    p = hsv2rgb(hsv) * (1.0 + dl * uHk.z * sw);
  }
  if (uBw) p = vec3(luma(clamp(p, 0.0, 1.0)));
  if (uGrdOn) p = grade(p);
  if (uLutOn) {
    vec3 q = clamp(p, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    p = mix(p, texture(uLut, q).rgb, uLutAmt);
  }
  o = vec4(clamp(p, 0.0, 1.0), 1.0);
}`;

const FRAG_DOWN = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uLod;
in vec2 vUv;
out vec4 o;
void main() { o = vec4(textureLod(uSrc, vUv, uLod).rgb, 1.0); }`;

const FRAG_FINISH = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uInvFull;          // source texels per full-resolution pixel
uniform vec2 uOutFull;           // output size in full-resolution px (for grain / vignette)
uniform mat2 uM;
uniform vec2 uC, uSz;
uniform float uAspect;
uniform bool uBypass;
uniform float uSharp, uRadius, uMasking, uNrL, uNrC;
uniform float uTexture, uClarity, uDehaze;
uniform float uGrain, uGrainSize, uGrainRough, uGrainFade;
uniform float uVigAmt, uVigMid, uVigFeather, uVigRound;
uniform int uOverlay;            // mask index to highlight, -1 none
uniform vec4 uMD[8];             // per mask local detail: texture, clarity, dehaze, sharpness
uniform bool uAnyDetail;
uniform float uDistort, uCaR, uCaB, uDefP, uDefG, uOutSharp;
uniform bool uAutoFringe;
uniform vec3 uBg;
in vec2 vUv;
out vec4 o;
${MASK_FN}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

vec2 suv;
vec3 tap(vec2 offFull) { return texture(uSrc, suv + offFull * uInvFull / uSrcSize).rgb; }
float blurLuma(float r) {   // 3x3 gaussian on luminance, r in full-res px
  return luma(tap(vec2(0.0))) * 0.25
    + (luma(tap(vec2(r, 0.0))) + luma(tap(vec2(-r, 0.0))) + luma(tap(vec2(0.0, r))) + luma(tap(vec2(0.0, -r)))) * 0.125
    + (luma(tap(vec2(r, r))) + luma(tap(vec2(-r, r))) + luma(tap(vec2(r, -r))) + luma(tap(vec2(-r, -r)))) * 0.0625;
}
vec3 blurRgb(float r) {
  return tap(vec2(0.0)) * 0.25
    + (tap(vec2(r, 0.0)) + tap(vec2(-r, 0.0)) + tap(vec2(0.0, r)) + tap(vec2(0.0, -r))) * 0.125
    + (tap(vec2(r, r)) + tap(vec2(-r, r)) + tap(vec2(r, -r)) + tap(vec2(-r, -r))) * 0.0625;
}

void main() {
  vec2 S = vec2(uAspect * 0.5, 0.5) + uM * (uC + (vUv - 0.5) * uSz);   // source, height units
  vec2 ctr = vec2(uAspect * 0.5, 0.5);
  if (uDistort != 0.0) {                                                // manual lens distortion, corners stay put so no empty edges appear
    vec2 q0 = S - ctr;
    float k = uDistort * 0.3;
    q0 *= (1.0 + k * dot(q0, q0) / dot(ctr, ctr)) / (1.0 + k);
    S = ctr + q0;
  }
  suv = S / vec2(uAspect, 1.0);
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) { o = vec4(uBg, 1.0); return; }
  vec3 p = texture(uSrc, suv).rgb;
  if (uBypass) { o = vec4(p, 1.0); return; }
  if (uCaR != 0.0 || uCaB != 0.0) {                                     // lateral chromatic aberration: scale red / blue about the centre
    vec2 qq = S - ctr;
    p = vec3(texture(uSrc, (ctr + qq * (1.0 + uCaR * 0.002)) / vec2(uAspect, 1.0)).r, p.g, texture(uSrc, (ctr + qq * (1.0 + uCaB * 0.002)) / vec2(uAspect, 1.0)).b);
  }
  if (uDefP > 0.0 || uDefG > 0.0 || uAutoFringe) {                      // defringe: desaturate purple / green next to high-contrast edges
    float dp = max(uDefP, uAutoFringe ? 0.7 : 0.0), dg = max(uDefG, uAutoFringe ? 0.7 : 0.0);
    float lc = luma(p), e = 0.0;
    e = max(e, abs(luma(tap(vec2(2.0, 0.0))) - lc)); e = max(e, abs(luma(tap(vec2(-2.0, 0.0))) - lc));
    e = max(e, abs(luma(tap(vec2(0.0, 2.0))) - lc)); e = max(e, abs(luma(tap(vec2(0.0, -2.0))) - lc));
    e = smoothstep(0.03, 0.18, e);
    vec2 hs = hueSat(clamp(p, 0.0, 1.0));
    float pm = smoothstep(0.64, 0.72, hs.x) * (1.0 - smoothstep(0.88, 0.95, hs.x));
    float gm = smoothstep(0.20, 0.27, hs.x) * (1.0 - smoothstep(0.40, 0.47, hs.x));
    p = mix(p, vec3(luma(p)), e * (pm * dp + gm * dg) * smoothstep(0.1, 0.3, hs.y));
  }
  vec3 p0 = p;

  // effective amounts = global + masks' local detail sliders
  float eSharp = uSharp, eTex = uTexture, eClar = uClarity, eDeh = uDehaze;
  if (uAnyDetail) {
    for (int i = 0; i < 8; i++) {
      vec4 d = uMD[i];
      if (d == vec4(0.0) || uMInfo[i].x < 0.5) continue;
      float w = maskWeight(i, S, suv, p0);
      if (w < 0.002) continue;
      eTex += w * d.x; eClar += w * d.y; eDeh += w * d.z; eSharp += w * d.w;
    }
    eTex = clamp(eTex, -1.0, 1.0); eClar = clamp(eClar, -1.0, 1.0); eDeh = clamp(eDeh, -1.0, 1.0); eSharp = clamp(eSharp, 0.0, 1.5);
  }

  // noise reduction: luminance via a 3x3 bilateral, colour via a wide chroma blur
  if (uNrL > 0.0) {
    float sig = mix(0.015, 0.2, uNrL);
    float rad = 1.0 + uNrL;
    float l0 = luma(p);
    vec3 acc = p; float ws = 1.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec3 s = tap(vec2(x, y) * rad);
      float d = luma(s) - l0;
      float w = exp(-d * d / (sig * sig)) * ((x == 0 || y == 0) ? 1.0 : 0.7);
      acc += s * w; ws += w;
    }
    p += luma(acc / ws) - l0;
  }
  if (uNrC > 0.0) {
    float r = 1.0 + uNrC * 3.0;
    vec3 acc = vec3(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) acc += tap(vec2(x, y) * r);
    vec3 b = acc / 9.0;
    p = mix(p, luma(p) + (b - luma(b)), uNrC);
  }

  // sharpening: unsharp mask on luminance, optionally restricted to edges (masking)
  if (eSharp > 0.0) {
    float l0 = luma(p);
    float det = l0 - blurLuma(uRadius);
    float m = uMasking > 0.0 ? smoothstep(0.0, 0.01 + uMasking * 0.08, abs(det)) : 1.0;
    p += det * eSharp * 3.0 * m;
  }

  // texture (fine detail) and clarity (local contrast, mid-tones); negative values smooth
  if (eTex != 0.0) {
    float l0 = luma(p);
    if (eTex > 0.0) p += (l0 - blurLuma(2.0)) * eTex * 2.0;
    else p = mix(p, blurRgb(2.0), -eTex * 0.8);
  }
  if (eClar != 0.0) {
    float l0 = luma(p);
    float lod = log2(max(1.0, 36.0 * uInvFull));
    vec3 big = textureLod(uSrc, suv, lod).rgb;
    float mid = 1.0 - pow(abs(2.0 * l0 - 1.0), 2.0) * 0.8;
    if (eClar > 0.0) p += (l0 - luma(big)) * eClar * 1.6 * mid;
    else p = mix(p, big, -eClar * 0.6 * mid);
  }
  // dehaze: dark-channel estimate at a coarse mip level
  if (eDeh != 0.0) {
    float lod = log2(max(1.0, 90.0 * uInvFull));
    vec3 big = textureLod(uSrc, suv, lod).rgb;
    float dc = min(big.r, min(big.g, big.b));
    const float AIR = 0.92;
    if (eDeh > 0.0) {
      float t = clamp(1.0 - eDeh * 0.9 * dc / AIR, 0.2, 1.0);
      p = (p - AIR) / t + AIR;
      p = mix(vec3(luma(p)), p, 1.0 + eDeh * 0.15);
    } else {
      p = mix(p, vec3(AIR), -eDeh * 0.45 * (1.0 - dc * 0.5));
    }
  }

  // post-crop vignette in output space
  if (uVigAmt != 0.0) {
    vec2 c = (vUv - 0.5) * 2.0;
    float aspect = uOutFull.x / uOutFull.y;
    float n = mix(2.0, 6.0, max(-uVigRound, 0.0));
    float r = pow(pow(abs(c.x), n) + pow(abs(c.y), n), 1.0 / n) / pow(2.0, 1.0 / n);
    if (uVigRound > 0.0) {
      vec2 cc = c * (aspect > 1.0 ? vec2(aspect, 1.0) : vec2(1.0, 1.0 / aspect)) / max(aspect, 1.0 / aspect);
      r = mix(r, length(cc) / 1.4142, uVigRound);
    }
    float start = mix(0.1, 0.85, uVigMid);
    float end = start + mix(0.05, 1.0, uVigFeather) * (1.2 - start);
    float m = smoothstep(start, end, r);
    p = uVigAmt < 0.0 ? p * (1.0 + uVigAmt * m * 0.95) : mix(p, vec3(1.0), uVigAmt * m * 0.8);
  }

  // film grain: fixed to the image, strongest in mid-tones, fades when zoomed far out
  if (uGrain > 0.0) {
    vec2 g = vUv * uOutFull / mix(1.0, 4.0, uGrainSize);
    float n = mix(vnoise(g), hash(floor(g)), uGrainRough) - 0.5;
    float w = 1.0 - pow(abs(luma(p) * 2.0 - 1.0), 2.0) * 0.7;
    p += n * uGrain * uGrainFade * 0.5 * w;
  }

  if (uOutSharp > 0.0) {                                                // output sharpening, sized for the exported pixels
    float l0 = luma(p);
    p += (l0 - blurLuma(0.8)) * uOutSharp * 1.6;
  }

  if (uOverlay >= 0) {
    float w = maskWeight(uOverlay, S, suv, p0);
    p = mix(p, vec3(1.0, 0.16, 0.22), w * 0.5);
  }
  o = vec4(clamp(p, 0.0, 1.0), 1.0);
}`;

// brush dabs, instanced: per dab (cx, cy, radius, hardness, flow) in layer px
const VERT_DAB = `#version 300 es
in vec2 aPos;
in vec4 aDab;      // cx, cy, radius, hardness
in float aFlow;
uniform vec2 uLayer;
out vec2 vQ;
out float vHard;
out float vFlow;
void main() {
  vQ = aPos;
  vHard = aDab.w;
  vFlow = aFlow;
  vec2 px = aDab.xy + aPos * aDab.z;
  gl_Position = vec4(px / uLayer * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAG_DAB = `#version 300 es
precision highp float;
in vec2 vQ;
in float vHard;
in float vFlow;
out vec4 o;
void main() {
  float a = vFlow * (1.0 - smoothstep(min(vHard, 0.98), 1.0, length(vQ)));
  o = vec4(a, a, a, a);
}`;

function program(gl, vs, fs, attribs = ['aPos']) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(prog, s);
  }
  attribs.forEach((a, i) => gl.bindAttribLocation(prog, i, a));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const cache = {};
  prog.u = (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(prog, n)));
  return prog;
}

const TYPE_CODE = { linear: 1, radial: 2, brush: 3 };

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: preserve || !!globalThis.__PRESERVE });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.edit = program(gl, VERT_EDIT, FRAG_EDIT);
    this.finish = program(gl, VERT_VIEW, FRAG_FINISH);
    this.down = program(gl, VERT_EDIT, FRAG_DOWN);
    this.dab = program(gl, VERT_DAB, FRAG_DAB, ['aPos', 'aDab', 'aFlow']);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // vertex array for full-screen quads (attribute 0 only)
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // vertex array for instanced dabs
    this.dabBuf = gl.createBuffer();
    this.dabVao = gl.createVertexArray();
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(this.quadVao);

    this.tex = null; this.texIsSrgb = false;
    this.fbo = null; this.fboTex = null;
    this.bFbo = null; this.bTex = null; this.beforeValid = false;
    this.sFbo = null; this.sTex = null; this.sw = 0; this.sh = 0; this.sBuf = null;
    this.imgW = 0; this.imgH = 0; this.fullW = 0; this.fullH = 0;
    this.view = { zoom: 1, px: 0, py: 0 };
    this.geo = null;

    // curve LUT
    this.curveTex = Renderer.tex2d(gl, 256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(identityCurves()));
    this.curveKey = '';
    // dummy brush layers + LUT so every sampler is always valid
    this.brushTex = null; this.brushLayers = 0; this.brushSize = [0, 0];
    this.layerState = [];
    this.allocBrush(1, 1, 1);
    this.lutTex = null; this.lutSize = 0; this.lutId = null;
    this.setLut(null);
  }

  static tex2d(gl, w, h, internal, format, type, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ---------- image + framebuffers ----------
  /** half: Uint16Array RGBA16F bits (linear). fullW/fullH: the real resolution this proxy stands for. */
  setImage(width, height, half, fullW = width, fullH = height) {
    const gl = this.gl;
    for (const t of [this.tex, this.fboTex, this.bTex, this.sTex]) if (t) gl.deleteTexture(t);
    for (const f of [this.fbo, this.bFbo, this.sFbo]) if (f) gl.deleteFramebuffer(f);
    this.tex = Renderer.tex2d(gl, width, height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, half);
    this.texIsSrgb = false;
    this.imgW = width; this.imgH = height; this.fullW = fullW; this.fullH = fullH;
    const mk = () => {
      const t = Renderer.tex2d(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
      return [t, f];
    };
    [this.fboTex, this.fbo] = mk();
    [this.bTex, this.bFbo] = mk();
    this.beforeValid = false;
    const sw = 256, sh = Math.max(1, Math.round((256 * height) / width));
    this.sw = sw; this.sh = sh; this.sBuf = new Uint8Array(sw * sh * 4);
    this.sTex = Renderer.tex2d(gl, sw, sh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.sFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.view = { zoom: 1, px: 0, py: 0 };
    this.layerState = [];      // brush layers must be redrawn for the new size
    this.allocBrush(width, height, Math.max(this.brushLayers, 1));
  }

  /** Replace the pixels of the working image (spot removal re-patches this). */
  updateSource(half) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.imgW, this.imgH, gl.RGBA, gl.HALF_FLOAT, half);
  }

  get aspect() { return this.imgW / this.imgH; }

  // ---------- geometry / view ----------
  setGeometry(geo) { this.geo = geo; }
  outAspect() { return this.geo ? this.geo.outAspect : this.aspect; }
  fit() {
    const ca = this.canvas.width / this.canvas.height, ia = this.outAspect();
    return ia > ca ? [1, ca / ia] : [ia / ca, 1];
  }
  /** Zoom value at which one full-resolution pixel equals one canvas (device) pixel. */
  zoom100() {
    const outFullW = this.geo ? this.geo.uSz[0] * this.fullH : this.fullW;
    return outFullW / (this.fit()[0] * this.canvas.width);
  }
  clampView() {
    const v = this.view, [fx, fy] = this.fit();
    v.zoom = Math.min(Math.max(v.zoom, 1), Math.max(this.zoom100() * 4, 1));
    const mx = Math.max(0, fx * v.zoom - 1), my = Math.max(0, fy * v.zoom - 1);
    v.px = mx ? Math.min(mx, Math.max(-mx, v.px)) : 0;
    v.py = my ? Math.min(my, Math.max(-my, v.py)) : 0;
  }
  /** output uv (0..1, y down) <-> canvas css-px-fraction (0..1, y down) under the current fit/zoom/pan */
  outToCanvas(u, v) {
    const [fx, fy] = this.fit(), z = this.view.zoom;
    const nx = (u * 2 - 1) * fx * z + this.view.px, ny = -(v * 2 - 1) * fy * z + this.view.py;
    return [(nx + 1) / 2, (1 - ny) / 2];
  }
  canvasToOut(cx, cy) {
    const [fx, fy] = this.fit(), z = this.view.zoom;
    const nx = cx * 2 - 1, ny = 1 - cy * 2;
    return [((nx - this.view.px) / (fx * z) + 1) / 2, (1 - (ny - this.view.py) / (fy * z)) / 2];
  }

  // ---------- LUT / curves / brush layers ----------
  setLut(lut) {
    const gl = this.gl;
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    const size = lut ? lut.size : 2;
    const data = lut ? lut.data : new Uint8Array(2 * 2 * 2 * 4).fill(255);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    this.lutTex = t; this.lutSize = lut ? size : 0; this.lutId = lut ? lut.id : null; this.lutInfo = lut || null;
  }

  updateCurves(curves) {
    const key = JSON.stringify(curves);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(curves));
  }

  allocBrush(w, h, layers) {
    const gl = this.gl;
    if (this.brushTex) gl.deleteTexture(this.brushTex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.brushTex = t; this.brushLayers = layers; this.brushSize = [w, h];
    this.layerState = [];
    if (!this.brushFbo) this.brushFbo = gl.createFramebuffer();
  }

  /** Turn a stroke into evenly spaced dabs (layer px). */
  static dabs(stroke, region) {
    const H = region.imgH, out = [];
    const r = Math.max(0.5, stroke.size * H * 0.5);
    const hard = 1 - stroke.feather;                 // feather 1 => fully soft edge
    const step = Math.max(0.75, r * 0.2);
    const pts = stroke.pts;
    const toPx = ([x, y]) => [x * H - region.x, y * H - region.y];
    const push = (p) => out.push(p[0], p[1], r, hard, stroke.flow);
    if (pts.length === 1) { push(toPx(pts[0])); return out; }
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = toPx(pts[i - 1]), b = toPx(pts[i]);
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (!len) continue;
      let d = carry;
      while (d <= len) { push([a[0] + (dx * d) / len, a[1] + (dy * d) / len]); d += step; }
      carry = d - len;
    }
    if (!out.length) push(toPx(pts[0]));
    return out;
  }

  /** Redraw brush layers whose strokes changed. regionPx is the layer's window onto the image. */
  syncBrush(masks, region) {
    const gl = this.gl;
    const brushes = [];
    for (const m of masks) for (const c of m.comps) if (c.type === 'brush' && brushes.length < MAX_BRUSH_MASKS) brushes.push(c);
    const need = Math.max(1, brushes.length);
    const rw = Math.round(region.w), rh = Math.round(region.h);
    if (need > this.brushLayers || this.brushSize[0] !== rw || this.brushSize[1] !== rh) this.allocBrush(rw, rh, Math.max(need, this.brushLayers));
    this.layerOf = {};
    gl.useProgram(this.dab);
    gl.bindVertexArray(this.dabVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.brushFbo);
    gl.viewport(0, 0, rw, rh);
    gl.uniform2f(this.dab.u('uLayer'), rw, rh);
    gl.enable(gl.BLEND);
    brushes.forEach((c, layer) => {
      this.layerOf[c.id] = layer;
      const key = `${c.id}:${c.rev}:${region.x},${region.y},${rw},${rh},${region.imgH}`;
      if (this.layerState[layer] === key) return;
      this.layerState[layer] = key;
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.brushTex, 0, layer);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      for (const st of c.strokes) {
        const d = Renderer.dabs(st, region);
        if (!d.length) continue;
        gl.blendFunc(st.erase ? gl.ZERO : gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d), gl.STREAM_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.length / 5);
      }
    });
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(this.quadVao);
  }

  // ---------- uniforms ----------
  /**
   * mode 'edit': masks that adjust tone / colour (pass 1). mode 'finish': masks with local detail, or all masks when keepAll
   * (mask overlay). Mask positions are kept so indices match the overlay lookup.
   */
  static packMasks(masks, layerOf, mode, keepAll = false) {
    const N = MAX_MASKS * MAX_COMPS;
    const g1 = new Float32Array(N * 4), g2 = new Float32Array(N * 4), cinfo = new Float32Array(N * 4);
    const info = new Float32Array(MAX_MASKS * 4);
    const A = new Float32Array(MAX_MASKS * 4), B = new Float32Array(MAX_MASKS * 4), C = new Float32Array(MAX_MASKS * 4), D = new Float32Array(MAX_MASKS * 4);
    let anyDetail = false;
    masks.slice(0, MAX_MASKS).forEach((m, i) => {
      const a = m.adj, dt = m.detail || {};
      const adjusts = Object.values(a).some((v) => v !== 0);
      const detail = Object.values(dt).some((v) => v !== 0);
      if (mode === 'edit' ? !adjusts : !(detail || keepAll)) return;
      info[i * 4] = m.comps.length;
      m.comps.slice(0, MAX_COMPS).forEach((c, j) => {
        const ci = i * MAX_COMPS + j;
        const layer = c.type === 'brush' ? layerOf?.[c.id] : 0;
        const code = layer === undefined ? 0 : { linear: 1, radial: 2, brush: 3, lum: 4, color: 5 }[c.type] || 0;
        cinfo.set([code, { add: 0, sub: 1, int: 2 }[c.op] ?? 0, c.invert ? 1 : 0, c.feather ?? 1], ci * 4);
        if (c.type === 'linear') g1.set([c.geo.x0, c.geo.y0, c.geo.x1, c.geo.y1], ci * 4);
        else if (c.type === 'radial') { g1.set([c.geo.cx, c.geo.cy, c.geo.rx, c.geo.ry], ci * 4); g2[ci * 4] = c.geo.angle || 0; }
        else if (c.type === 'brush') g2[ci * 4 + 3] = layer || 0;
        else if (c.type === 'lum') g1.set([c.range.lo, c.range.hi, c.range.smooth, 0], ci * 4);
        else if (c.type === 'color') g1.set([c.range.hue / 360, c.range.range, c.range.satMin, c.range.smooth], ci * 4);
      });
      A.set([a.exposure, a.contrast / 100, a.highlights / 100, a.shadows / 100], i * 4);
      B.set([a.whites / 100, a.blacks / 100, a.temp / 100, a.tint / 100], i * 4);
      C.set([a.vibrance / 100, a.saturation / 100, 0, 0], i * 4);
      D.set([(dt.texture || 0) / 100, (dt.clarity || 0) / 100, (dt.dehaze || 0) / 100, (dt.sharpness || 0) / 100], i * 4);
      if (detail) anyDetail = true;
    });
    return { g1, g2, cinfo, info, A, B, C, D, anyDetail };
  }

  setMaskUniforms(p, packed) {
    const gl = this.gl;
    gl.uniform4fv(p.u('uCGeo1'), packed.g1);
    gl.uniform4fv(p.u('uCGeo2'), packed.g2);
    gl.uniform4fv(p.u('uCInfo'), packed.cinfo);
    gl.uniform4fv(p.u('uMInfo'), packed.info);
  }

  passEdit(state, bypass, target = this.fbo, region = null) {
    const gl = this.gl, p = this.edit, par = state.p;
    const reg = region || { x: 0, y: 0, w: this.imgW, h: this.imgH };
    gl.useProgram(p);
    gl.bindVertexArray(this.quadVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, reg.w, reg.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.uniform1i(p.u('uTex'), 0); gl.uniform1i(p.u('uCurve'), 1); gl.uniform1i(p.u('uBrush'), 2); gl.uniform1i(p.u('uLut'), 3);
    const o = region?.tex || { origin: [0, 0], size: [this.imgW, this.imgH] };
    gl.uniform2f(p.u('uImgPx'), region?.imgW || this.imgW, region?.imgH || this.imgH);
    gl.uniform4f(p.u('uRegion'), reg.x, reg.y, reg.w, reg.h);
    gl.uniform2f(p.u('uTexOrigin'), o.origin[0], o.origin[1]);
    gl.uniform2f(p.u('uTexSize'), o.size[0], o.size[1]);
    gl.uniform4f(p.u('uGA'), par.exposure, par.contrast / 100, par.highlights / 100, par.shadows / 100);
    gl.uniform4f(p.u('uGB'), par.whites / 100, par.blacks / 100, par.temp / 100, par.tint / 100);
    gl.uniform4f(p.u('uGC'), par.vibrance / 100, par.saturation / 100, 0, 0);
    const pk = Renderer.packMasks(state.masks || [], this.layerOf, 'edit');
    this.setMaskUniforms(p, pk);
    gl.uniform4fv(p.u('uMA'), pk.A); gl.uniform4fv(p.u('uMB'), pk.B); gl.uniform4fv(p.u('uMC'), pk.C);
    const hsl = new Float32Array(24);
    let hslOn = false;
    HSL_BANDS.forEach(([b], i) => ['hue', 'sat', 'lum'].forEach((k, j) => {
      const v = (par[`hsl_${b}_${k}`] || 0) / 100;
      hsl[i * 3 + j] = v; if (v) hslOn = true;
    }));
    gl.uniform3fv(p.u('uHsl'), hsl);
    gl.uniform1fv(p.u('CEN'), TUNE.hsC);
    gl.uniform4f(p.u('uHk'), TUNE.hsH, TUNE.hsS, TUNE.hsL, TUNE.hsM);
    gl.uniform1i(p.u('uHslOn'), hslOn ? 1 : 0);
    const grd = new Float32Array(12);
    let grdOn = false;
    GRADE_ZONES.forEach(([z], i) => {
      const h = par[`grade_${z}_hue`] / 360, s = par[`grade_${z}_sat`] / 100, l = par[`grade_${z}_lum`] / 100;
      grd.set([h, s, l], i * 3);
      if (s || l) grdOn = true;
    });
    gl.uniform3fv(p.u('uGrd'), grd);
    gl.uniform2f(p.u('uGrdBB'), par.grade_blend / 100, par.grade_balance / 100);
    gl.uniform4f(p.u('uTn'), 0, 0, TUNE.hlK, TUNE.hlLo);
    gl.uniform1f(p.u('uGrdK'), TUNE.grdK);
    gl.uniform4f(p.u('uGt'), TUNE.gdL, TUNE.gdA, TUNE.gdB, TUNE.gdF);
    gl.uniform2f(p.u('uMk'), TUNE.msK, state.raw ? TUNE.rawWbL : TUNE.wbL);
    gl.uniformMatrix3fv(p.u('uWmT'), false, colMajor(TUNE.wbKt)); gl.uniformMatrix3fv(p.u('uWmN'), false, colMajor(TUNE.wbKn));
    gl.uniform1f(p.u('uKnee'), TUNE.knee);
    gl.uniform1f(p.u('uCtP'), TUNE.ctP);
    gl.uniform1f(p.u('uPPe'), TUNE.ppExp);
    gl.uniform1i(p.u('uRawOn'), state.raw ? 1 : 0);
    gl.uniform1f(p.u('uRawOff'), rawCamStops(state.camera));
    { const cc = state.raw ? rawCamCurve(state.camera) : null; gl.uniform1i(p.u('uRawCc'), cc ? 1 : 0); if (cc) gl.uniform3fv(p.u('uRawCcK'), cc); else gl.uniform3fv(p.u('uRawCcK'), new Float32Array(51)); }
    gl.uniform2f(p.u('uRawHl'), TUNE.rawHlPos, TUNE.rawHlNeg);
    gl.uniform3fv(p.u('uRB'), TUNE.rawBase);
    gl.uniform2f(p.u('uRBx'), TUNE.rawX0, TUNE.rawDx);
    gl.uniform1f(p.u('uPPc'), TUNE.ppCurve);
    gl.uniform2f(p.u('uWf'), TUNE.wbF, TUNE.wbA);
    gl.uniform4f(p.u('uTn4'), TUNE.vbK, TUNE.saK, TUNE.wbS, TUNE.satLin);
    gl.uniform4f(p.u('uTn2'), state.raw ? TUNE.rawExK : TUNE.exK, TUNE.ctK, TUNE.shK, TUNE.shHi);
    gl.uniform4f(p.u('uTn3'), TUNE.whK, TUNE.blK, TUNE.hlTop, TUNE.shLift);
    gl.uniform1i(p.u('uGrdOn'), grdOn ? 1 : 0);
    gl.uniform1i(p.u('uCurveOn'), curvesActive(par.curves) ? 1 : 0);
    gl.uniform1i(p.u('uBw'), par.bw ? 1 : 0);
    const lutOn = !!(par.lut && this.lutSize && this.lutId === par.lut);
    gl.uniform1i(p.u('uLutOn'), lutOn ? 1 : 0);
    gl.uniform1f(p.u('uLutAmt'), (par.lutAmount ?? 100) / 100);
    gl.uniform1f(p.u('uLutSize'), this.lutSize || 2);
    gl.uniform1f(p.u('uLensVig'), (par.lensVignette || 0) / 100);
    {   // calibration matrix: columns are the adjusted red / green / blue primaries, rows normalised so neutrals stay neutral
      const hr = (par.calRedHue || 0) / 100, sr = (par.calRedSat || 0) / 100, hg = (par.calGreenHue || 0) / 100, sg = (par.calGreenSat || 0) / 100;
      const hb = (par.calBlueHue || 0) / 100, sb = (par.calBlueSat || 0) / 100, tint = (par.calShadowTint || 0) / 100;
      const k = 0.4, W = [0.2126, 0.7152, 0.0722];
      const sat = (v, s) => { const g = v[0] * W[0] + v[1] * W[1] + v[2] * W[2], f = 1 + s * 0.6; return v.map((x) => g + (x - g) * f); };
      const R = sat([1, Math.max(hr, 0) * k, Math.max(-hr, 0) * k], sr);      // + hue: red toward orange / - toward magenta
      const G = sat([Math.max(-hg, 0) * k, 1, Math.max(hg, 0) * k], sg);      // + hue: green toward cyan / - toward yellow
      const B = sat([Math.max(hb, 0) * k, Math.max(-hb, 0) * k, 1], sb);      // + hue: blue toward purple / - toward cyan
      const rows = [[R[0], G[0], B[0]], [R[1], G[1], B[1]], [R[2], G[2], B[2]]].map((r) => { const t = r[0] + r[1] + r[2] || 1; return r.map((x) => x / t); });
      const on = [hr, sr, hg, sg, hb, sb, tint].some((v) => v !== 0);
      gl.uniformMatrix3fv(p.u('uCalM'), false, [rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]]);
      gl.uniform1f(p.u('uCalTint'), tint);
      gl.uniform1i(p.u('uCalOn'), on ? 1 : 0);
    }
    gl.uniform1i(p.u('uBypass'), bypass ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  mip(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** viewport: [x, y, w, h] in canvas px. tex: which pass-1 result to read. */
  passFinish(state, bypass, { fit = true, viewport = null, band = [0, 1], tex = this.fboTex, outFull = null, fullScale = null, overlay = -1, size = null, outSharp = 0, target = null } = {}) {
    const gl = this.gl, p = this.finish, par = state.p, geo = this.geo;
    gl.useProgram(p);
    gl.bindVertexArray(this.quadVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    const vp = viewport || [0, 0, this.canvas.width, this.canvas.height];
    gl.viewport(...vp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
    gl.uniform1i(p.u('uSrc'), 0); gl.uniform1i(p.u('uBrush'), 2);
    const sz = size || [this.imgW, this.imgH];
    gl.uniform2f(p.u('uSrcSize'), sz[0], sz[1]);
    const fs = fullScale ?? (this.fullH / this.imgH);
    gl.uniform1f(p.u('uInvFull'), 1 / fs);
    const of = outFull || [geo.uSz[0] * this.fullH, geo.uSz[1] * this.fullH];
    gl.uniform2f(p.u('uOutFull'), of[0], of[1]);
    gl.uniformMatrix2fv(p.u('uM'), false, geo.uM);
    gl.uniform2f(p.u('uC'), geo.uC[0], geo.uC[1]);
    gl.uniform2f(p.u('uSz'), geo.uSz[0], geo.uSz[1]);
    gl.uniform1f(p.u('uAspect'), geo.A);
    let fx = 1, fy = 1, z = 1, px = 0, py = 0;
    if (fit) { [fx, fy] = this.fit(); ({ zoom: z, px, py } = this.view); }
    gl.uniform2f(p.u('uFit'), fx, fy);
    gl.uniform1f(p.u('uZoom'), z);
    gl.uniform2f(p.u('uPan'), px, py);
    gl.uniform2f(p.u('uBand'), band[0], band[1]);
    const U = {
      uSharp: par.sharpAmount / 100, uRadius: par.sharpRadius, uMasking: par.sharpMasking / 100,
      uNrL: par.nrLuma / 100, uNrC: par.nrColor / 100,
      uTexture: par.texture / 100, uClarity: par.clarity / 100, uDehaze: par.dehaze / 100,
      uGrain: par.grainAmount / 100, uGrainSize: par.grainSize / 100, uGrainRough: par.grainRoughness / 100,
      uVigAmt: par.vigAmount / 100, uVigMid: par.vigMidpoint / 100, uVigFeather: par.vigFeather / 100, uVigRound: par.vigRoundness / 100,
    };
    for (const [k, v] of Object.entries(U)) gl.uniform1f(p.u(k), v);
    // grain amplitude fades when zoomed out so the point-sampled noise doesn't alias
    const shown = fit ? (this.canvas.width * fx * z) / Math.max(1, of[0]) : 1;
    gl.uniform1f(p.u('uGrainFade'), Math.min(1, Math.sqrt(Math.max(0, shown) * 1.5)));
    gl.uniform1f(p.u('uDistort'), (par.distortion || 0) / 100);
    gl.uniform1f(p.u('uCaR'), (par.caRed || 0) / 100); gl.uniform1f(p.u('uCaB'), (par.caBlue || 0) / 100);
    gl.uniform1f(p.u('uDefP'), (par.defringePurple || 0) / 100); gl.uniform1f(p.u('uDefG'), (par.defringeGreen || 0) / 100);
    gl.uniform1i(p.u('uAutoFringe'), par.caRemove ? 1 : 0);
    gl.uniform1f(p.u('uOutSharp'), outSharp);
    gl.uniform3f(p.u('uBg'), 0.06, 0.06, 0.07);
    gl.uniform1i(p.u('uOverlay'), overlay);
    const pk = Renderer.packMasks(state.masks || [], this.layerOf, 'finish', overlay >= 0);
    this.setMaskUniforms(p, pk);
    gl.uniform4fv(p.u('uMD'), pk.D);
    gl.uniform1i(p.u('uAnyDetail'), pk.anyDetail ? 1 : 0);
    gl.uniform1i(p.u('uBypass'), bypass ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * editChanged=false re-uses the cached pass-1 result (pure zoom / pan).
   * split: null or 0..1 divider position; left of it shows the unedited image.
   */
  draw(state, { bypass = false, editChanged = true, measure = false, split = null, overlay = -1 } = {}) {
    if (!this.tex || !this.geo) return 0;
    const t0 = measure ? performance.now() : 0;
    const gl = this.gl;
    this.clampView();
    if (editChanged) {
      this.updateCurves(state.p.curves);
      this.syncBrush(state.masks || [], { x: 0, y: 0, w: this.imgW, h: this.imgH, imgH: this.imgH });
      this.passEdit(state, bypass);
      this.mip(this.fboTex);
    }
    gl.clearColor(0.06, 0.06, 0.07, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (split != null) {
      if (!this.beforeValid) {
        this.passEdit({ p: state.p, masks: [] }, true, this.bFbo);
        this.mip(this.bTex); this.beforeValid = true;
      }
      const cw = this.canvas.width, ch = this.canvas.height, x = Math.round(Math.min(1, Math.max(0, split)) * cw);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, x, ch);
      this.passFinish(state, true, { tex: this.bTex });
      gl.scissor(x, 0, cw - x, ch);
      this.passFinish(state, bypass, { overlay });
      gl.disable(gl.SCISSOR_TEST);
    } else {
      this.passFinish(state, bypass, { overlay });
    }
    if (measure) { gl.finish(); return performance.now() - t0; }
    return 0;
  }

  // ---------- full-resolution export (pass 1 in horizontal strips) ----------
  /** Allocate the full-size pass-1 result (RGBA8, mipmapped) plus a strip target. */
  /** 16-bit export needs half-float render targets. */
  get floatTargets() { return !!(this.gl.getExtension('EXT_color_buffer_float') || this.gl.getExtension('EXT_color_buffer_half_float')); }
  beginFull(FW, FH, stripRows = 512, { float = false } = {}) {
    const gl = this.gl;
    this.imgW = FW; this.imgH = FH; this.fullW = FW; this.fullH = FH;
    const [fi, ff, ft] = float ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    this.fboTex = Renderer.tex2d(gl, FW, FH, fi, ff, ft, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.stripRows = stripRows;
    this.stripTex = Renderer.tex2d(gl, FW, stripRows, fi, ff, ft, null);
    this.stripFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stripFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.stripTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Export framebuffer incomplete (image too large for this device?)');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  /** Source for strips: a texture covering image rows [origin.y, origin.y + size.y). */
  renderStrip(state, y0, rows, src) {
    const gl = this.gl, FW = this.imgW, FH = this.imgH;
    this.updateCurves(state.p.curves);
    this.syncBrush(state.masks || [], { x: 0, y: y0, w: FW, h: rows, imgH: FH });
    const keep = this.tex;
    this.tex = src.tex;
    this.passEdit(state, false, this.stripFbo, { x: 0, y: y0, w: FW, h: rows, imgW: FW, imgH: FH, tex: { origin: src.origin, size: src.size } });
    this.tex = keep;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stripFbo);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, y0, 0, 0, FW, rows);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  endFull() { this.mip(this.fboTex); }
  /** Final pass at export size. Canvas must already be outW x outH. */
  finishFull(state, outW, outH, { outSharp = 0 } = {}) {
    this.canvas.width = outW; this.canvas.height = outH;
    this.passFinish(state, false, { fit: false, size: [this.imgW, this.imgH], fullScale: outW / this.imgW, outFull: [outW, outH], outSharp });
  }
  /**
   * Final pass in horizontal bands into a half-float target, read back as 16-bit RGB. onBand(Uint16Array rows) is called top to bottom.
   * Keeps GPU / CPU memory bounded for very large 16-bit exports.
   */
  async finishFullBands(state, outW, outH, onBand, { outSharp = 0, rows = 128 } = {}) {
    const gl = this.gl;
    const tex = Renderer.tex2d(gl, outW, rows, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('16-bit export is not supported on this device');
    const buf = new Float32Array(outW * rows * 4);
    for (let top = 0; top < outH; top += rows) {
      const n = Math.min(rows, outH - top);
      this.passFinish(state, false, { fit: false, size: [this.imgW, this.imgH], fullScale: outW / this.imgW, outFull: [outW, outH], outSharp, target: fbo, viewport: [0, 0, outW, n], band: [top / outH, n / outH] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.readPixels(0, 0, outW, n, gl.RGBA, gl.FLOAT, buf);
      const out = new Uint16Array(outW * n * 3);
      for (let r = 0; r < n; r++) {
        let o = r * outW * 3, i = (n - 1 - r) * outW * 4;          // flip: first row of the band is its top
        for (let x = 0; x < outW; x++, i += 4, o += 3) {
          out[o] = Math.round(Math.min(1, Math.max(0, buf[i])) * 65535);
          out[o + 1] = Math.round(Math.min(1, Math.max(0, buf[i + 1])) * 65535);
          out[o + 2] = Math.round(Math.min(1, Math.max(0, buf[i + 2])) * 65535);
        }
      }
      await onBand(out, top, n);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
  }
  /**
   * Same as finishFullBands but 8-bit: onBand(Uint8Array RGBA rows, top, n), top to bottom. Needs no canvas of the output size,
   * so photos above Safari's ~16 MP canvas limit can still be encoded.
   */
  async finishFullBands8(state, outW, outH, onBand, { outSharp = 0, rows = 128 } = {}) {
    const gl = this.gl;
    const tex = Renderer.tex2d(gl, outW, rows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Export target is not supported on this device');
    const buf = new Uint8Array(outW * rows * 4), out = new Uint8Array(outW * rows * 4);
    for (let top = 0; top < outH; top += rows) {
      const n = Math.min(rows, outH - top);
      this.passFinish(state, false, { fit: false, size: [this.imgW, this.imgH], fullScale: outW / this.imgW, outFull: [outW, outH], outSharp, target: fbo, viewport: [0, 0, outW, n], band: [top / outH, n / outH] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.readPixels(0, 0, outW, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let r = 0; r < n; r++) out.set(buf.subarray((n - 1 - r) * outW * 4, (n - r) * outW * 4), r * outW * 4);   // flip
      await onBand(out.subarray(0, outW * n * 4), top, n);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
  }
  dispose() { try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} }

  // ---------- preset / look thumbnails ----------
  /** half: RGBA16F bits of a small copy of the photo (about 192 px wide). */
  setSmall(w, h, half) {
    const gl = this.gl;
    if (this.smallTex) gl.deleteTexture(this.smallTex);
    if (this.thumbTex) gl.deleteTexture(this.thumbTex);
    if (this.thumbFbo) gl.deleteFramebuffer(this.thumbFbo);
    this.smallTex = Renderer.tex2d(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, half);
    this.thumbTex = Renderer.tex2d(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.thumbFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumbFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.thumbTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.smallW = w; this.smallH = h;
  }

  /** Render pass 1 only on the small copy for each state ({ p, lut? }); returns [{ w, h, data }]. */
  renderThumbs(states) {
    if (!this.smallTex) return [];
    const gl = this.gl, w = this.smallW, h = this.smallH;
    const keepTex = this.tex, keepLut = this.lutInfo;
    const out = [];
    this.tex = this.smallTex;
    for (const st of states) {
      if (st.lut) this.setLut(st.lut);
      this.passEdit({ p: st.p, masks: [] }, false, this.thumbFbo, { x: 0, y: 0, w, h, imgW: w, imgH: h, tex: { origin: [0, 0], size: [w, h] } });
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumbFbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      out.push({ w, h, data: buf });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.tex = keepTex;
    if (keepLut !== undefined) this.setLut(keepLut);
    return out;
  }

  /** Mark the cached "before" render stale (new image). */
  invalidateBefore() { this.beforeValid = false; }

  /** Downscaled copy of the current edited image (pass-1 result): { w, h, data: RGBA8, top row first }. */
  readSmall() {
    if (!this.tex) return null;
    const gl = this.gl, p = this.down;
    gl.useProgram(p);
    gl.bindVertexArray(this.quadVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sFbo);
    gl.viewport(0, 0, this.sw, this.sh);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(p.u('uSrc'), 0);
    gl.uniform1f(p.u('uLod'), Math.max(0, Math.log2(this.imgW / this.sw)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, this.sw, this.sh, gl.RGBA, gl.UNSIGNED_BYTE, this.sBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w: this.sw, h: this.sh, data: this.sBuf };
  }

  /** Render the cropped, edited proxy at its native size and encode (preview-resolution export). */
  async exportProxy(state, type, quality) {
    const c = this.canvas, prevW = c.width, prevH = c.height, geo = this.geo;
    const ow = Math.max(1, Math.round(geo.uSz[0] * this.imgH)), oh = Math.max(1, Math.round(geo.uSz[1] * this.imgH));
    c.width = ow; c.height = oh;
    this.updateCurves(state.p.curves);
    this.syncBrush(state.masks || [], { x: 0, y: 0, w: this.imgW, h: this.imgH, imgH: this.imgH });
    this.passEdit(state, false);
    this.mip(this.fboTex);
    this.passFinish(state, false, { fit: false });
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    c.width = prevW; c.height = prevH;
    return blob;
  }
}

// ---- tone curve LUT ----
export function buildLut(c) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = evalCurve(c.rgb, i / 255);
    out[i * 4] = Math.round(255 * evalCurve(c.r, m));
    out[i * 4 + 1] = Math.round(255 * evalCurve(c.g, m));
    out[i * 4 + 2] = Math.round(255 * evalCurve(c.b, m));
    out[i * 4 + 3] = 255;
  }
  return out;
}
