// Minimal EXIF reader / patcher for JPEG APP1 segments.

/** Find the EXIF APP1 segment in a JPEG. Returns { seg, tiff } (seg includes the FFE1 marker and length) or null. */
export function extractExif(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
      const seg = bytes.slice(i, i + 2 + len);
      return { seg, tiff: 10 };            // 2 marker + 2 length + 6 "Exif\0\0"
    }
    i += 2 + len;
  }
  return null;
}

function reader(buf, base) {
  const le = buf[base] === 0x49;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    le,
    u16: (o) => dv.getUint16(base + o, le), u32: (o) => dv.getUint32(base + o, le),
    set16: (o, v) => dv.setUint16(base + o, v, le), set32: (o, v) => dv.setUint32(base + o, v, le),
    ascii: (o, n) => { let s = ''; for (let k = 0; k < n; k++) { const c = buf[base + o + k]; if (!c) break; s += String.fromCharCode(c); } return s.trim(); },
  };
}
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(r, off, wanted) {
  const out = {}, n = r.u16(off);
  for (let k = 0; k < n; k++) {
    const e = off + 2 + k * 12, tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
    if (!wanted.has(tag)) continue;
    const size = (TYPE_SIZE[type] || 1) * count;
    const vo = size <= 4 ? e + 8 : r.u32(e + 8);
    let v;
    if (type === 2) v = r.ascii(vo, count);
    else if (type === 3) v = r.u16(vo);
    else if (type === 4) v = r.u32(vo);
    else if (type === 5) v = r.u32(vo + 4) ? r.u32(vo) / r.u32(vo + 4) : 0;
    out[tag] = { v, e, type };
  }
  return { entries: out, n, end: off + 2 + n * 12 };
}

export function parseExif(info) {
  if (!info) return null;
  try {
    const r = reader(info.seg, info.tiff);
    if (r.u16(2) !== 42) return null;
    const ifd0 = readIfd(r, r.u32(4), new Set([0x010f, 0x0110, 0x0112, 0x0132, 0x8769]));
    const g = (t) => ifd0.entries[t]?.v;
    const out = { make: g(0x010f), model: g(0x0110), orientation: g(0x0112), date: g(0x0132) };
    if (g(0x8769)) {
      const ex = readIfd(r, g(0x8769), new Set([0x829a, 0x829d, 0x8827, 0x9003, 0x920a, 0xa434, 0xa405, 0xa002, 0xa003]));
      const x = (t) => ex.entries[t]?.v;
      Object.assign(out, { exposure: x(0x829a), fnumber: x(0x829d), iso: x(0x8827), dateOriginal: x(0x9003), focal: x(0x920a), lens: x(0xa434), focal35: x(0xa405) });
    }
    return out;
  } catch { return null; }
}

/** Copy of the APP1 segment with orientation reset to 1, the embedded thumbnail dropped and pixel dimensions updated. */
export function patchExif(info, w, h) {
  const seg = info.seg.slice();
  try {
    const r = reader(seg, info.tiff);
    const off0 = r.u32(4);
    const ifd0 = readIfd(r, off0, new Set([0x0112, 0x8769]));
    if (ifd0.entries[0x0112]) r.set16(ifd0.entries[0x0112].e + 8, 1);
    r.set32(ifd0.end, 0);                                   // no IFD1 -> readers ignore the stale thumbnail
    if (ifd0.entries[0x8769]) {
      const ex = readIfd(r, ifd0.entries[0x8769].v, new Set([0xa002, 0xa003]));
      for (const [tag, val] of [[0xa002, w], [0xa003, h]]) {
        const en = ex.entries[tag];
        if (!en) continue;
        if (en.type === 3) r.set16(en.e + 8, Math.min(65535, val)); else r.set32(en.e + 8, val);
      }
    }
  } catch { /* leave as is */ }
  return seg;
}

/** Insert an APP1 EXIF segment right after SOI / JFIF in a JPEG blob. */
export async function injectExif(jpegBlob, seg) {
  const b = new Uint8Array(await jpegBlob.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return jpegBlob;
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);   // keep JFIF first
  const out = new Uint8Array(b.length + seg.length);
  out.set(b.subarray(0, at), 0); out.set(seg, at); out.set(b.subarray(at), at + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}

export const fmtExposure = (e) => (!e ? '' : e >= 1 ? `${e}s` : `1/${Math.round(1 / e)}s`);
