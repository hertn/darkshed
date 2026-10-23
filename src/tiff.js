// Uncompressed 16-bit RGB TIFF writer (little endian), fed row by row so memory stays bounded.
/**
 * rows: array of Uint16Array chunks, each a whole number of rows of interleaved RGB, top row first.
 * icc: optional ICC profile bytes.
 */
export function tiff16(width, height, rows, icc) {
  const dataSize = width * height * 3 * 2;
  const entries = [];
  const extra = [];                       // blobs placed after the data (BitsPerSample, resolution, ICC)
  const E = (tag, type, count, value) => entries.push({ tag, type, count, value });
  const SHORT = 3, LONG = 4, RATIONAL = 5, UNDEF = 7;
  let dataStart = 8;
  let tail = dataStart + dataSize;
  const place = (bytes) => { const at = tail; extra.push(bytes); tail += bytes.length + (bytes.length & 1); return at; };
  const u16s = (...v) => { const a = new Uint8Array(v.length * 2); const dv = new DataView(a.buffer); v.forEach((x, i) => dv.setUint16(i * 2, x, true)); return a; };
  const u32s = (...v) => { const a = new Uint8Array(v.length * 4); const dv = new DataView(a.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x, true)); return a; };
  E(256, LONG, 1, width); E(257, LONG, 1, height);
  E(258, SHORT, 3, place(u16s(16, 16, 16)));
  E(259, SHORT, 1, 1); E(262, SHORT, 1, 2);
  E(273, LONG, 1, dataStart);
  E(277, SHORT, 1, 3); E(278, LONG, 1, height); E(279, LONG, 1, dataSize);
  E(282, RATIONAL, 1, place(u32s(300, 1))); E(283, RATIONAL, 1, place(u32s(300, 1)));
  E(284, SHORT, 1, 1); E(296, SHORT, 1, 2);
  if (icc) E(34675, UNDEF, icc.length, place(icc));
  entries.sort((a, b) => a.tag - b.tag);
  const ifdAt = tail + (tail & 1);
  const ifd = new Uint8Array(2 + entries.length * 12 + 4), dv = new DataView(ifd.buffer);
  dv.setUint16(0, entries.length, true);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true); dv.setUint32(o + 4, e.count, true);
    const small = (e.type === SHORT && e.count === 1);
    if (small) dv.setUint16(o + 8, e.value, true); else dv.setUint32(o + 8, e.value, true);
  });
  const header = new Uint8Array([0x49, 0x49, 42, 0, ...new Uint8Array(u32s(ifdAt))]);
  const parts = [header, ...rows];
  for (const x of extra) { parts.push(x); if (x.length & 1) parts.push(new Uint8Array(1)); }
  if ((tail & 1) && false) parts.push(new Uint8Array(1));
  parts.push(ifd);
  return new Blob(parts, { type: 'image/tiff' });
}
