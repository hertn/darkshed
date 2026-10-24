// Baseline JPEG encoder core (Annex K tables, 4:2:0 or 4:4:4). It encodes one MCU row at a time into its own byte-aligned
// segment, with the DC predictors reset, so the segments are independent: they can be encoded in parallel on worker threads
// and joined with restart markers (jpeg.js does that).

const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];
const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const HUFF = {
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

function qtable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((t) => Math.min(255, Math.max(1, Math.floor((t * s + 50) / 100))));
}

// AAN scaled DCT: the scale factors are folded into the quantiser, so the transform itself is only adds and a few multiplies
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
const reciprocal = (q) => { const r = new Float32Array(64); for (let i = 0; i < 64; i++) r[i] = 1 / (q[i] * AAN[i >> 3] * AAN[i & 7] * 8); return r; };

function dct8(d, o, s) {            // in place on d[o], d[o+s], ... d[o+7s]
  const t0 = d[o] + d[o + 7 * s], t7 = d[o] - d[o + 7 * s], t1 = d[o + s] + d[o + 6 * s], t6 = d[o + s] - d[o + 6 * s];
  const t2 = d[o + 2 * s] + d[o + 5 * s], t5 = d[o + 2 * s] - d[o + 5 * s], t3 = d[o + 3 * s] + d[o + 4 * s], t4 = d[o + 3 * s] - d[o + 4 * s];
  let a = t0 + t3; const b = t0 - t3, c = t1 + t2, e = t1 - t2;
  d[o] = a + c; d[o + 4 * s] = a - c;
  const z1 = (e + b) * 0.707106781;
  d[o + 2 * s] = b + z1; d[o + 6 * s] = b - z1;
  a = t4 + t5; const f = t5 + t6, g = t6 + t7;
  const z5 = (a - g) * 0.382683433, z2 = 0.541196100 * a + z5, z4 = 1.306562965 * g + z5, z3 = f * 0.707106781;
  const z11 = t7 + z3, z13 = t7 - z3;
  d[o + 5 * s] = z13 + z2; d[o + 3 * s] = z13 - z2; d[o + 1 * s] = z11 + z4; d[o + 7 * s] = z11 - z4;
}

/** Header bytes (up to the start of the scan data) and an encoder for single MCU rows. */
export function makeCore(W, H, { quality = 90, subsample = true } = {}) {
  const ql = qtable(QL, quality), qc = qtable(QC, quality);
  const rl = reciprocal(ql), rc = reciprocal(qc);
  const S = subsample ? 2 : 1, MCU = 8 * S;                    // MCU is 16 x 16 pixels (4:2:0) or 8 x 8 (4:4:4)
  const mcuCols = Math.ceil(W / MCU), mcuRows = Math.ceil(H / MCU), pw = mcuCols * MCU;
  const hDcL = codes(HUFF.dcL), hDcC = codes(HUFF.dcC), hAcL = codes(HUFF.acL), hAcC = codes(HUFF.acC);

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
  hb(0xff, 0xdd); w16(4); w16(mcuCols);                         // restart after every MCU row
  hb(0xff, 0xda); w16(12); hb(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);

  const Y = new Float32Array(pw * MCU), CB = new Float32Array(pw * MCU), CR = new Float32Array(pw * MCU);
  const cw = pw / S, CBs = new Float32Array(cw * 8), CRs = new Float32Array(cw * 8);
  const blk = new Float32Array(64), coef = new Int32Array(64);
  let out = new Uint8Array(1 << 16), op = 0, acc = 0, nb = 0;
  const dc = [0, 0, 0];

  const byte = (b) => { if (op === out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; } out[op++] = b; };
  const put = (code, len) => {
    acc = (acc << len) | code; nb += len;
    while (nb >= 8) { const b = (acc >> (nb - 8)) & 255; byte(b); if (b === 255) byte(0); nb -= 8; }
    acc &= (1 << nb) - 1;
  };

  const encodeBlock = (plane, stride, x0, y0, comp) => {
    const rq = comp === 0 ? rl : rc, hd = comp === 0 ? hDcL : hDcC, ha = comp === 0 ? hAcL : hAcC;
    for (let y = 0; y < 8; y++) { const o = (y0 + y) * stride + x0; for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[o + x] - 128; }
    for (let y = 0; y < 8; y++) dct8(blk, y * 8, 1);
    for (let x = 0; x < 8; x++) dct8(blk, x, 8);
    for (let i = 0; i < 64; i++) { const z = ZZ[i], v = blk[z] * rq[z]; coef[i] = v < 0 ? -Math.round(-v) : Math.round(v); }
    const diff = coef[0] - dc[comp]; dc[comp] = coef[0];
    let a = Math.abs(diff), n = 0; while (a) { n++; a >>= 1; }
    put(hd.code[n], hd.len[n]); if (n) put(diff < 0 ? (diff - 1) & ((1 << n) - 1) : diff, n);
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

  return {
    head: Uint8Array.from(head), mcuCols, mcuRows, MCU,
    /** rgba: `rows` (1..MCU) consecutive rows of W pixels. Returns this MCU row's entropy-coded bytes (byte aligned, no marker). */
    encodeRows(rgba, rows) {
      op = 0; acc = 0; nb = 0; dc[0] = dc[1] = dc[2] = 0;
      for (let y = 0; y < MCU; y++) {
        const sy = Math.min(y, rows - 1);                // pad below the last row by repeating it
        for (let x = 0; x < pw; x++) {
          const o = (sy * W + Math.min(x, W - 1)) * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], i = y * pw + x;
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
      if (nb) put((1 << (8 - nb)) - 1, 8 - nb);          // pad the last byte with 1s
      return out.slice(0, op);
    },
  };
}
