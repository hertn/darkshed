import LibRaw from 'libraw-wasm';
import { extractExif, parseExif } from './exif.js';

// Longest edge of the editing proxy. Keeps the GPU texture ~50MB (RGBA16F) so iOS Safari stays happy.
export const MAX_PROXY = 3200;

const RAW_EXT = /\.(raf|dng|cr2|cr3|nef|arw|orf|rw2|pef|srw|raw)$/i;

// float32 -> float16 bit pattern, for v in [0, 65504]
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v) {
  if (v <= 0) return 0;
  f32[0] = v;
  const x = u32[0];
  let e = ((x >> 23) & 0xff) - 112;
  if (e <= 0) return (x & 0x7fffff | 0x800000) >> (1 - e + 13) & 0x3ff;
  if (e >= 31) return 0x7bff;
  return (e << 10) | ((x >> 13) & 0x3ff);
}

export const lutLinear16 = (() => {
  const t = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = toHalf(i / 65535);
  return t;
})();

const lutSrgb8 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    t[i] = toHalf(s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
  }
  return t;
})();

export const ONE = toHalf(1);

export const isRaw = (file) => RAW_EXT.test(file.name);

/** Returns { width, height, half: Uint16Array(RGBA half floats, linear sRGB), info } */
export async function loadImage(file, onStatus = () => {}) {
  const t0 = performance.now();
  if (isRaw(file)) {
    onStatus('Reading file…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const raw = new LibRaw();
    try {
      onStatus('Decoding RAW…');
      await raw.open(bytes, {
        halfSize: true,      // fast, light on memory: proxy only
        useCameraWb: true,
        outputBps: 16,
        outputColor: 1,      // sRGB primaries
        noAutoBright: true,
        gamm: [1, 1],        // keep linear, we do tone mapping on the GPU
        userQual: 0,
        highlight: 0,
      });
      const meta = await raw.metadata(true);
      const cd = meta.color_data || {};
      const wbInfo = cd.cam_mul && cd.cam_mul[1] > 0 && cd.cam_xyz && cd.rgb_cam
        ? { camMul: cd.cam_mul.slice(0, 3), camXyz: cd.cam_xyz.slice(0, 3).map((r) => r.slice(0, 3)), rgbCam: cd.rgb_cam.slice(0, 3).map((r) => r.slice(0, 3)) } : null;
      let exifInfo = null;
      try { const t = await raw.thumbnailData(); if (t && t.format === 'jpeg') exifInfo = extractExif(t.data); } catch {}
      const d = await raw.imageData();
      const decodeMs = performance.now() - t0;
      onStatus('Building texture…');
      const out = rgb16ToHalfRGBA(d.data, d.width, d.height, d.colors || 3);
      return {
        ...out,
        fullW: out.width * out.k * 2, fullH: out.height * out.k * 2,   // half-size decode, then box-reduced by k
        info: {
          kind: 'RAW',
          camera: `${meta.camera_make || ''} ${meta.camera_model || ''}`.trim(),
          source: `${meta.width}×${meta.height}`,
          decodeMs,
          exifSeg: exifInfo, exif: parseExif(exifInfo), wb: wbInfo,
          raw: { iso: meta.iso_speed, shutter: meta.shutter, aperture: meta.aperture, focal: meta.focal_len, ts: meta.timestamp },
        },
      };
    } finally {
      raw.dispose();
    }
  }

  onStatus('Decoding image…');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, MAX_PROXY / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;
  const half = new Uint16Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    half[i * 4] = lutSrgb8[src[i * 4]];
    half[i * 4 + 1] = lutSrgb8[src[i * 4 + 1]];
    half[i * 4 + 2] = lutSrgb8[src[i * 4 + 2]];
    half[i * 4 + 3] = ONE;
  }
  const fullW = bmp.width, fullH = bmp.height;
  let exifInfo = null;
  try { exifInfo = extractExif(new Uint8Array(await file.slice(0, 262144).arrayBuffer())); } catch {}
  const ex = parseExif(exifInfo);
  const info = { kind: 'JPEG/bitmap', camera: ex ? `${ex.make || ''} ${ex.model || ''}`.trim() : '', source: `${fullW}×${fullH}`, decodeMs: performance.now() - t0, exifSeg: exifInfo, exif: ex };
  bmp.close();
  return { width: w, height: h, half, fullW, fullH, info };
}

// Integer box-downscale (if needed) + pack RGB16 -> RGBA16F
function rgb16ToHalfRGBA(src, sw, sh, ch) {
  const k = Math.max(1, Math.ceil(Math.max(sw, sh) / MAX_PROXY));
  const w = Math.floor(sw / k);
  const h = Math.floor(sh / k);
  const half = new Uint16Array(w * h * 4);
  const kk = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = ((y * k + dy) * sw + x * k) * ch;
        for (let dx = 0; dx < k; dx++, p += ch) {
          r += src[p]; g += src[p + 1]; b += src[p + 2];
        }
      }
      const o = (y * w + x) * 4;
      half[o] = lutLinear16[(r / kk) | 0];
      half[o + 1] = lutLinear16[(g / kk) | 0];
      half[o + 2] = lutLinear16[(b / kk) | 0];
      half[o + 3] = ONE;
    }
  }
  return { width: w, height: h, half, k };
}

/** Small preview for the filmstrip: embedded JPEG for RAWs (fast), downscaled bitmap otherwise. Returns ImageBitmap or null. */
export async function loadThumb(file, maxEdge = 240) {
  try {
    let blob = file;
    if (isRaw(file)) {
      const raw = new LibRaw();
      try {
        await raw.open(new Uint8Array(await file.arrayBuffer()), { halfSize: true });
        const t = await raw.thumbnailData();
        if (!t || t.format !== 'jpeg') return null;
        blob = new Blob([t.data], { type: 'image/jpeg' });
      } finally { raw.dispose(); }
    }
    const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const s = Math.min(1, maxEdge / Math.max(full.width, full.height));
    const bmp = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * s)), resizeHeight: Math.max(1, Math.round(full.height * s)), resizeQuality: 'medium' });
    full.close();
    return bmp;
  } catch (e) { console.warn('thumb failed', e); return null; }
}

/** ~w px wide copy of a decoded proxy (RGBA16F bits), for look thumbnails. Averages 2x2 blocks via float. */
export function makeSmall(img, w = 192) {
  const sw = img.width, sh = img.height;
  const k = Math.max(1, Math.floor(sw / w));
  const ow = Math.floor(sw / k), oh = Math.floor(sh / k);
  const out = new Uint16Array(ow * oh * 4);
  const src = img.half;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const i = ((y * k) * sw + x * k) * 4, o = (y * ow + x) * 4;
    out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = ONE;
  }
  return { w: ow, h: oh, half: out };
}

/**
 * Full-resolution decode for export. RAW -> { kind: 'raw', rgb16 (linear, interleaved), width, height, colors, exifSeg }
 * Others -> { kind: 'bitmap', bitmap, width, height, exifSeg }.
 * quality: LibRaw demosaic quality, 1 = fast / good, 3 = slower / best for X-Trans.
 */
export async function loadFull(file, { quality = 1, maxDim = 16384, outputColor = 1, onStatus = () => {} } = {}) {
  if (isRaw(file)) {
    onStatus('Reading file…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const run = async (half) => {
      const raw = new LibRaw();
      try {
        onStatus(half ? 'Decoding RAW (reduced size)…' : 'Decoding RAW at full resolution…');
        await raw.open(bytes.slice(), { halfSize: half, useCameraWb: true, outputBps: 16, outputColor, noAutoBright: true, gamm: [1, 1], userQual: quality, highlight: 0 });
        let exifSeg = null, camera = '';
        try { const m = await raw.metadata(true); camera = `${m.camera_make || ''} ${m.camera_model || ''}`.trim(); } catch {}
        try { const t = await raw.thumbnailData(); if (t && t.format === 'jpeg') exifSeg = extractExif(t.data); } catch {}
        const d = await raw.imageData();
        return { kind: 'raw', rgb16: d.data, width: d.width, height: d.height, colors: d.colors || 3, exifSeg, camera, reduced: half };
      } finally { raw.dispose(); }
    };
    try {
      const r = await run(false);
      if (r.width > maxDim || r.height > maxDim) { r.rgb16 = null; return await run(true); }
      return r;
    } catch (e) {
      console.warn('full RAW decode failed, retrying at reduced size', e);
      return await run(true);
    }
  }
  onStatus('Decoding image…');
  let exifSeg = null;
  try { exifSeg = extractExif(new Uint8Array(await file.slice(0, 262144).arrayBuffer())); } catch {}
  let bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  if (Math.max(bmp.width, bmp.height) > maxDim) {
    const s = maxDim / Math.max(bmp.width, bmp.height);
    const rs = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * s), resizeHeight: Math.round(bmp.height * s), resizeQuality: 'high' });
    bmp.close(); bmp = rs;
  }
  return { kind: 'bitmap', bitmap: bmp, width: bmp.width, height: bmp.height, exifSeg };
}
