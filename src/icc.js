// Display P3 ICC profile (matrix / TRC, v2) + embedding helpers for JPEG and PNG.
const s15 = (v) => Math.round(v * 65536);
let cached = null;

export function displayP3Profile() {
  if (cached) return cached;
  const N = 1024;
  const sig = (s) => [...s].map((c) => c.charCodeAt(0));
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const be16 = (v) => [(v >> 8) & 255, v & 255];
  const xyzTag = (x, y, z) => [...sig('XYZ '), 0, 0, 0, 0, ...be32(s15(x) >>> 0), ...be32(s15(y) >>> 0), ...be32(s15(z) >>> 0)];
  // sRGB transfer curve as a 1024 point table
  const curv = [...sig('curv'), 0, 0, 0, 0, ...be32(N)];
  for (let i = 0; i < N; i++) { const x = i / (N - 1); const y = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); curv.push(...be16(Math.round(y * 65535))); }
  const cprt = [...sig('text'), 0, 0, 0, 0, ...sig('Public domain'), 0];
  const descText = 'Display P3';
  const desc = [...sig('desc'), 0, 0, 0, 0, ...be32(descText.length + 1), ...sig(descText), 0, ...be32(0), ...be32(0), 0, 0, 0, ...new Array(67).fill(0)];
  const pad = (a) => { while (a.length % 4) a.push(0); return a; };
  const tags = [
    ['desc', pad(desc)], ['cprt', pad(cprt)], ['wtpt', xyzTag(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyzTag(0.5151, 0.2412, -0.0011)], ['gXYZ', xyzTag(0.2920, 0.6922, 0.0419)], ['bXYZ', xyzTag(0.1571, 0.0666, 0.7841)],
    ['rTRC', curv], ['gTRC', 'rTRC'], ['bTRC', 'rTRC'],
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const body = [], table = [];
  const placed = {};
  for (const [name, data] of tags) {
    if (typeof data === 'string') { table.push(...sig(name), ...be32(placed[data][0]), ...be32(placed[data][1])); continue; }
    placed[name] = [offset, data.length];
    table.push(...sig(name), ...be32(offset), ...be32(data.length));
    body.push(...data); offset += data.length;
    while (offset % 4) { body.push(0); offset++; }
  }
  const total = 128 + tableSize + body.length;
  const header = new Array(128).fill(0);
  const put = (at, arr) => arr.forEach((v, i) => { header[at + i] = v; });
  put(0, be32(total)); put(8, [2, 0x10, 0, 0]); put(12, sig('mntr')); put(16, sig('RGB ')); put(20, sig('XYZ '));
  put(24, [...be16(2024), ...be16(1), ...be16(1), ...be16(0), ...be16(0), ...be16(0)]);
  put(36, sig('acsp')); put(40, sig('APPL')); put(64, be32(0));
  put(68, be32(s15(0.9642) >>> 0)); put(72, be32(s15(1.0) >>> 0)); put(76, be32(s15(0.8249) >>> 0));
  cached = new Uint8Array([...header, ...be32(tags.length), ...table, ...body]);
  return cached;
}

/** Insert an ICC profile into a JPEG blob (APP2, after EXIF / JFIF). */
export async function injectIccJpeg(blob, icc) {
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return blob;
  let at = 2;
  while (b[at] === 0xff && (b[at + 1] === 0xe0 || b[at + 1] === 0xe1)) at += 2 + ((b[at + 2] << 8) | b[at + 3]);
  const L = icc.length + 16;                                   // length field counts itself (2) + identifier (12) + seq / count (2)
  const seg = new Uint8Array(2 + 2 + 12 + 2 + icc.length);
  seg.set([0xff, 0xe2, (L >> 8) & 255, L & 255], 0);
  seg.set([...'ICC_PROFILE'].map((c) => c.charCodeAt(0)).concat([0, 1, 1]), 4);
  seg.set(icc, 4 + 14);
  const out = new Uint8Array(b.length + seg.length);
  out.set(b.subarray(0, at), 0); out.set(seg, at); out.set(b.subarray(at), at + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}

const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Insert an iCCP chunk into a PNG blob (right after IHDR). */
export async function injectIccPng(blob, icc, name = 'Display P3') {
  const b = new Uint8Array(await blob.arrayBuffer());
  const z = new Uint8Array(await new Response(new Blob([icc]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const nm = [...name].map((c) => c.charCodeAt(0));
  const data = new Uint8Array(nm.length + 2 + z.length); data.set(nm, 0); data[nm.length] = 0; data[nm.length + 1] = 0; data.set(z, nm.length + 2);
  const chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length); chunk.set([0x69, 0x43, 0x43, 0x50], 4); chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc(chunk.subarray(4, 8 + data.length)));
  const at = 8 + 25;                                  // signature + IHDR chunk
  const out = new Uint8Array(b.length + chunk.length);
  out.set(b.subarray(0, at), 0); out.set(chunk, at); out.set(b.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}
