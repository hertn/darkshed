// Streaming baseline JPEG encoder. Takes RGBA rows top to bottom, so a photo of any size can be saved without a canvas
// (iOS Safari refuses canvases above ~16 MP). Standard Annex K tables; 4:2:0 or 4:4:4 chroma.

const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];
const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const HUFF = {
  dcL: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: rng(0, 11) },
  dcC: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: rng(0, 11) },
  acL: {
    bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    vals: [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
      0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, ...rng(0x34, 0x3a), ...rng(0x43, 0x4a), ...rng(0x53, 0x5a), ...rng(0x63, 0x6a), ...rng(0x73, 0x7a),
      ...rng(0x83, 0x8a), ...rng(0x92, 0x9a), ...rng(0xa2, 0xaa), ...rng(0xb2, 0xba), ...rng(0xc2, 0xca), ...rng(0xd2, 0xda), ...rng(0xe1, 0xea), ...rng(0xf1, 0xfa)],
  },
  acC: {
    bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    vals: [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
      0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, ...rng(0x35, 0x3a), ...rng(0x43, 0x4a), ...rng(0x53, 0x5a), ...rng(0x63, 0x6a), ...rng(0x73, 0x7a),
      ...rng(0x82, 0x8a), ...rng(0x92, 0x9a), ...rng(0xa2, 0xaa), ...rng(0xb2, 0xba), ...rng(0xc2, 0xca), ...rng(0xd2, 0xda), ...rng(0xe2, 0xea), ...rng(0xf2, 0xfa)],
  },
};

/** Canonical Huffman codes from a (bits, vals) table: code[symbol] / len[symbol]. */
function codes({ bits, vals }) {
  const code = new Uint16Array(256), len = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) { for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c++; len[vals[k]] = l; k++; } c <<= 1; }
  return { code, len };
}

const COS = new Float32Array(64);                    // COS[u * 8 + x] = c(u) cos((2x + 1) u pi / 16) / 2
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;

function qtable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((t) => Math.min(255, Math.max(1, Math.floor((t * s + 50) / 100))));
}

/**
 * const enc = jpegEncoder(width, height, { quality: 1..100, subsample: true });
 * enc.push(rgbaRows, rowCount) for consecutive bands from the top, then const blob = enc.finish().
 */
export function jpegEncoder(W, H, { quality = 90, subsample = true } = {}) {
  const ql = qtable(QL, quality), qc = qtable(QC, quality);
  const S = subsample ? 2 : 1, MCU = 8 * S;                    // MCU is 16 x 16 pixels (4:2:0) or 8 x 8 (4:4:4)
  const mcuCols = Math.ceil(W / MCU), mcuRows = Math.ceil(H / MCU), pw = mcuCols * MCU;
  const hDcL = codes(HUFF.dcL), hDcC = codes(HUFF.dcC), hAcL = codes(HUFF.acL), hAcC = codes(HUFF.acC);
  const chunks = [];
  let out = new Uint8Array(1 << 20), op = 0;
  const flush = () => { chunks.push(out.subarray(0, op)); out = new Uint8Array(1 << 20); op = 0; };
  const byte = (b) => { if (op === out.length) flush(); out[op++] = b; };
  const head = [];
  const hb = (...a) => head.push(...a);
  const w16 = (v) => hb(v >> 8, v & 255);
  hb(0xff, 0xd8);
  hb(0xff, 0xe0); w16(16); hb(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0); w16(1); w16(1); hb(0, 0);       // JFIF
  for (const [id, t] of [[0, ql], [1, qc]]) { hb(0xff, 0xdb); w16(67); hb(id); for (let i = 0; i < 64; i++) hb(t[ZZ[i]]); }
  hb(0xff, 0xc0); w16(17); hb(8); w16(H); w16(W); hb(3, 1, S * 16 + S, 0, 2, 0x11, 1, 3, 0x11, 1);
  for (const [cls, id, t] of [[0, 0, HUFF.dcL], [1, 0, HUFF.acL], [0, 1, HUFF.dcC], [1, 1, HUFF.acC]]) {
    hb(0xff, 0xc4); w16(19 + t.vals.length); hb(cls * 16 + id, ...t.bits, ...t.vals);
  }
  hb(0xff, 0xda); w16(12); hb(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);
  for (const b of head) byte(b);

  // bit writer
  let acc = 0, nb = 0;
  const put = (code, len) => {
    acc = (acc << len) | code; nb += len;
    while (nb >= 8) { const b = (acc >> (nb - 8)) & 255; byte(b); if (b === 255) byte(0); nb -= 8; }
    acc &= (1 << nb) - 1;
  };
  const dc = [0, 0, 0];
  const blk = new Float32Array(64), tmp = new Float32Array(64), coef = new Int32Array(64);
  const encodeBlock = (plane, stride, x0, y0, comp) => {
    const q = comp === 0 ? ql : qc, hd = comp === 0 ? hDcL : hDcC, ha = comp === 0 ? hAcL : hAcC;
    for (let y = 0; y < 8; y++) { const o = (y0 + y) * stride + x0; for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[o + x] - 128; }
    for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) { let s = 0; for (let y = 0; y < 8; y++) s += COS[u * 8 + y] * blk[y * 8 + x]; tmp[u * 8 + x] = s; }   // columns
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let x = 0; x < 8; x++) s += COS[v * 8 + x] * tmp[u * 8 + x]; blk[u * 8 + v] = s; }   // rows
    for (let i = 0; i < 64; i++) coef[i] = Math.round(blk[ZZ[i]] / q[ZZ[i]]);
    // DC
    const diff = coef[0] - dc[comp]; dc[comp] = coef[0];
    let a = Math.abs(diff), n = 0; while (a) { n++; a >>= 1; }
    put(hd.code[n], hd.len[n]); if (n) put(diff < 0 ? (diff - 1) & ((1 << n) - 1) : diff, n);
    // AC
    let run = 0;
    for (let i = 1; i < 64; i++) {
      const v = coef[i];
      if (v === 0) { run++; continue; }
      while (run > 15) { put(ha.code[0xf0], ha.len[0xf0]); run -= 16; }
      let m = Math.abs(v), s = 0; while (m) { s++; m >>= 1; }
      const sym = run * 16 + s; put(ha.code[sym], ha.len[sym]); put(v < 0 ? (v - 1) & ((1 << s) - 1) : v, s);
      run = 0;
    }
    if (run) put(ha.code[0], ha.len[0]);
  };

  // planes for one MCU row
  const Y = new Float32Array(pw * MCU), CB = new Float32Array(pw * MCU), CR = new Float32Array(pw * MCU);
  const cw = pw / S, CBs = new Float32Array(cw * 8), CRs = new Float32Array(cw * 8);
  const pending = new Uint8Array(W * 4 * MCU);      // rows waiting for a full MCU row
  let have = 0, doneRows = 0, mcuRow = 0;

  const encodeMcuRow = (rows) => {
    for (let y = 0; y < MCU; y++) {
      const sy = Math.min(y, rows - 1);                // pad below the last row by repeating it
      for (let x = 0; x < pw; x++) {
        const o = (sy * W + Math.min(x, W - 1)) * 4, r = pending[o], g = pending[o + 1], b = pending[o + 2], i = y * pw + x;
        Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        CB[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        CR[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      }
    }
    if (S === 2) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < cw; x++) {
        const i = 2 * y * pw + 2 * x;
        CBs[y * cw + x] = (CB[i] + CB[i + 1] + CB[i + pw] + CB[i + pw + 1]) / 4;
        CRs[y * cw + x] = (CR[i] + CR[i + 1] + CR[i + pw] + CR[i + pw + 1]) / 4;
      }
    }
    for (let m = 0; m < mcuCols; m++) {
      for (let by = 0; by < S; by++) for (let bx = 0; bx < S; bx++) encodeBlock(Y, pw, m * MCU + bx * 8, by * 8, 0);
      if (S === 2) { encodeBlock(CBs, cw, m * 8, 0, 1); encodeBlock(CRs, cw, m * 8, 0, 2); }
      else { encodeBlock(CB, pw, m * 8, 0, 1); encodeBlock(CR, pw, m * 8, 0, 2); }
    }
    mcuRow++;
  };

  return {
    push(rgba, n) {
      for (let r = 0; r < n; r++) {
        pending.set(rgba.subarray(r * W * 4, (r + 1) * W * 4), have * W * 4);
        have++; doneRows++;
        if (have === MCU) { encodeMcuRow(MCU); have = 0; }
      }
    },
    finish() {
      if (have) encodeMcuRow(have);
      if (doneRows !== H || mcuRow !== mcuRows) throw new Error(`JPEG encoder got ${doneRows} of ${H} rows`);
      if (nb) put((1 << (8 - nb)) - 1, 8 - nb);        // pad the last byte with 1s
      byte(0xff); byte(0xd9);
      chunks.push(out.subarray(0, op));
      return new Blob(chunks, { type: 'image/jpeg' });
    },
  };
}
