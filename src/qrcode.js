'use strict';

// Zero-dependency QR code generator (byte mode, error-correction level M,
// versions 1-16 ≈ up to 450 bytes). Produces an SVG string, which the /qr
// route serves to 'qr:' slides — no external generator, works fully offline.
//
// Implements the essentials of ISO/IEC 18004: Reed-Solomon over GF(256),
// block interleaving, all 8 masks with penalty scoring, format + version info.

// ---- GF(256) arithmetic for Reed-Solomon --------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// Generator polynomial for `degree` EC codewords.
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse(); // highest degree first is easier below
}

function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Uint8Array(data.length + degree);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (!factor) continue;
    for (let j = 1; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// ---- version tables (error-correction level M) ---------------------------------

// [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
const EC_BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
  5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]], 11: [30, [[1, 50], [4, 51]]],
  12: [22, [[6, 36], [2, 37]]], 13: [22, [[8, 37], [1, 38]]], 14: [24, [[4, 40], [5, 41]]],
  15: [24, [[5, 41], [5, 42]]], 16: [28, [[7, 45], [3, 46]]],
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
  8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
};

function dataCapacity(version) {
  const [, blocks] = EC_BLOCKS[version];
  return blocks.reduce((n, [count, size]) => n + count * size, 0);
}

// ---- bit buffer -----------------------------------------------------------------

class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
    return bytes;
  }
}

// ---- matrix construction ----------------------------------------------------------

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const grid = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { grid[r][c] = v ? 1 : 0; };

  // finder patterns + separators
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // alignment patterns (skip any overlapping a finder)
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      if (grid[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (grid[6][i] === null) set(6, i, i % 2 === 0);
    if (grid[i][6] === null) set(i, 6, i % 2 === 0);
  }

  // dark module + reserve format info areas
  set(version * 4 + 9, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (grid[8][i] === null) grid[8][i] = 0;
    if (grid[i][8] === null) grid[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = 0;
    if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = 0;
  }

  // reserve version info areas (v >= 7)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        grid[size - 11 + j][i] = 0;
        grid[i][size - 11 + j] = 0;
      }
    }
  }

  const functional = grid.map((row) => row.map((v) => v !== null));

  // zigzag data placement with mask applied
  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][mask];

  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // timing column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (functional[r][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        bitIndex++;
        grid[r][c] = maskFn(r, c) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }

  // format info: EC level M ('00') + mask, BCH(15,5), XOR mask 0x5412
  let fmt = (0b00 << 3) | mask;
  let rem = fmt;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  fmt = ((fmt << 10) | rem) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    // copy 1 (around top-left finder)
    if (i < 6) grid[i][8] = bit;
    else if (i < 8) grid[i + 1][8] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;
    // copy 2 (split between the other two finders)
    if (i < 8) grid[8][size - 1 - i] = bit;
    else grid[size - 15 + i][8] = bit;
  }

  // version info (v >= 7): 18-bit Golay code
  if (version >= 7) {
    let vrem = version;
    for (let i = 0; i < 12; i++) vrem = (vrem << 1) ^ ((vrem >> 11) * 0x1f25);
    const bitsV = (version << 12) | vrem;
    for (let i = 0; i < 18; i++) {
      const bit = (bitsV >> i) & 1;
      grid[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
      grid[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
  }

  return grid;
}

// ---- mask penalty (standard N1-N4 rules) --------------------------------------------

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  // N1: runs of 5+ same-colour modules
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = pass ? grid[j][i] : grid[i][j];
        const prev = pass ? grid[j - 1][i] : grid[i][j - 1];
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += run - 2;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  // N3: finder-like 1011101 with 4 light modules either side
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        const match = (pat) => pat.every((p, k) => (pass ? grid[j + k][i] : grid[i][j + k]) === p);
        if (match(pat1) || match(pat2)) score += 40;
      }
    }
  }
  // N4: dark-module balance
  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ---- public API ------------------------------------------------------------------------

// Returns the module matrix (array of rows of 0/1) for `text`, or throws if too long.
function qrMatrix(text) {
  const data = Buffer.from(String(text), 'utf8');

  let version = 0;
  for (let v = 1; v <= 16; v++) {
    const lengthBits = v <= 9 ? 8 : 16;
    const capacityBits = dataCapacity(v) * 8;
    if (4 + lengthBits + data.length * 8 <= capacityBits) { version = v; break; }
  }
  if (!version) throw new Error('QR payload too long (max ~450 bytes)');

  // encode: mode 0100 (byte), length, data, terminator, pads
  const bits = new Bits();
  bits.push(0b0100, 4);
  bits.push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) bits.push(b, 8);
  const capacity = dataCapacity(version) * 8;
  bits.push(0, Math.min(4, capacity - bits.bits.length));
  while (bits.bits.length % 8 !== 0) bits.bits.push(0);
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (bits.bits.length < capacity) bits.push(padBytes[p++ % 2], 8);

  // split into blocks, compute EC, interleave
  const [ecPerBlock, blockDefs] = EC_BLOCKS[version];
  const dataBytes = bits.toBytes();
  const blocks = [];
  let offset = 0;
  for (const [count, sizePer] of blockDefs) {
    for (let i = 0; i < count; i++) {
      const block = dataBytes.slice(offset, offset + sizePer);
      offset += sizePer;
      blocks.push({ data: block, ec: rsEncode(block, ecPerBlock) });
    }
  }
  const interleaved = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) interleaved.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) interleaved.push(b.ec[i]);

  // pick the best of the 8 masks
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = buildMatrix(version, interleaved, mask);
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; best = grid; }
  }
  return best;
}

// Black-on-white SVG with a 4-module quiet zone.
function qrSvg(text) {
  const grid = qrMatrix(text);
  const size = grid.length;
  const quiet = 4;
  const total = size + quiet * 2;
  let rects = '';
  for (let r = 0; r < size; r++) {
    // merge horizontal runs into single rects to keep the SVG small
    let c = 0;
    while (c < size) {
      if (!grid[r][c]) { c++; continue; }
      let run = 0;
      while (c + run < size && grid[r][c + run]) run++;
      rects += `<rect x="${c + quiet}" y="${r + quiet}" width="${run}" height="1"/>`;
      c += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

module.exports = { qrMatrix, qrSvg };
