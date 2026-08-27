#!/usr/bin/env node
/*
 * Generates the printable QR code for the app redirect page.
 *
 * The QR itself is STATIC - it always encodes the same URL. The device
 * detection happens on open.html once the phone opens the link, so one
 * printed code serves both App Store and Play Store.
 *
 * Usage:
 *   node qrgen.js                       # uses DEFAULT_URL below
 *   node qrgen.js "https://..."         # encode a different link
 *
 * Output: mobo-qr.svg (vector, best for print) and mobo-qr.png
 *
 * QR encoding follows ISO/IEC 18004; structure per Nayuki's reference design (MIT).
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const DEFAULT_URL = 'https://abhijithcybro.github.io/redirect/open.html?app=fullsuite';

// Error correction level: 0=L(7%) 1=M(15%) 2=Q(25%) 3=H(30%).
// Q is the sweet spot for print - survives smudges and small sizes.
const ECC_LEVEL = 2;

const ECC_CW_PER_BLOCK = [
  [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,26,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
];

const NUM_EC_BLOCKS = [
  [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  [-1,1,1,2,4,4,4,5,5,8,9,9,10,12,12,17,16,18,21,20,23,23,26,28,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
];

const FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver, ecl) {
  return Math.floor(numRawDataModules(ver) / 8)
    - ECC_CW_PER_BLOCK[ecl][ver] * NUM_EC_BLOCKS[ecl][ver];
}

function alignPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_EC_BLOCKS[ecl][ver];
  const blockEccLen = ECC_CW_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const div = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function makeQr(text, ecl) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));

  let ver = 1;
  for (; ver <= 40; ver++) {
    const cap = numDataCodewords(ver, ecl) * 8;
    const need = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= cap) break;
  }
  if (ver > 40) throw new Error('Text too long for a QR code.');

  const bits = [];
  const appendBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  appendBits(4, 4);                              // byte mode indicator
  appendBits(bytes.length, ver < 10 ? 8 : 16);   // character count
  for (const b of bytes) appendBits(b, 8);

  const capacityBits = numDataCodewords(ver, ecl) * 8;
  appendBits(0, Math.min(4, capacityBits - bits.length));  // terminator
  appendBits(0, (8 - bits.length % 8) % 8);                // pad to a byte
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);

  const dataCw = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => { dataCw[i >>> 3] |= bit << (7 - (i & 7)); });

  const allCw = addEccAndInterleave(dataCw, ver, ecl);

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFn[y][x] = true;
  };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  const pos = alignPatternPositions(ver);
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  const drawFormat = (mask) => {
    const data = FORMAT_BITS[ecl] << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(b, i));
    setFn(8, 7, getBit(b, 6));
    setFn(8, 8, getBit(b, 7));
    setFn(7, 8, getBit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(b, i));
    setFn(8, size - 8, true); // always-dark module
  };
  drawFormat(0);

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const b = ver << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(b, i);
      const a = size - 11 + i % 3, c = Math.floor(i / 3);
      setFn(a, c, bit); setFn(c, a, bit);
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < allCw.length * 8) {
          modules[y][x] = getBit(allCw[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!isFn[y][x] && maskFn[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  };

  const addHistory = (run, hist) => {
    if (hist[0] === 0) run += size;  // light border before the first run
    hist.pop(); hist.unshift(run);
  };
  const countPatterns = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0)
         + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const terminateAndCount = (color, run, hist) => {
    if (color) { addHistory(run, hist); run = 0; }
    run += size;                     // light border after the last run
    addHistory(run, hist);
    return countPatterns(hist);
  };

  const penalty = () => {
    let result = 0;
    const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    for (let y = 0; y < size; y++) {
      let color = false, run = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === color) { run++; if (run === 5) result += N1; else if (run > 5) result++; }
        else {
          addHistory(run, hist);
          if (!color) result += countPatterns(hist) * N3;
          color = modules[y][x]; run = 1;
        }
      }
      result += terminateAndCount(color, run, hist) * N3;
    }
    for (let x = 0; x < size; x++) {
      let color = false, run = 0; const hist = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === color) { run++; if (run === 5) result += N1; else if (run > 5) result++; }
        else {
          addHistory(run, hist);
          if (!color) result += countPatterns(hist) * N3;
          color = modules[y][x]; run = 1;
        }
      }
      result += terminateAndCount(color, run, hist) * N3;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += N2;
    }
    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * N4;
  };

  // Mask choice is deterministic: same URL in, same pattern out, every run.
  let bestMask = 0, minPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < minPenalty) { minPenalty = p; bestMask = m; }
    applyMask(m); // undo - XOR is its own inverse
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return { size, modules, version: ver, mask: bestMask };
}

/* ---------- output ---------- */

function toSvg(qr, quiet) {
  const dim = qr.size + quiet * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.modules[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `width="${dim * 20}" height="${dim * 20}" shape-rendering="crispEdges">\n` +
    `  <rect width="${dim}" height="${dim}" fill="#ffffff"/>\n` +
    `  <path d="${path}" fill="#000000"/>\n</svg>\n`;
}

// Minimal 8-bit grayscale PNG writer - avoids pulling in an image dependency.
function toPng(qr, quiet, scale) {
  const dim = (qr.size + quiet * 2) * scale;
  const raw = Buffer.alloc((dim + 1) * dim, 0xFF);
  for (let y = 0; y < dim; y++) {
    raw[y * (dim + 1)] = 0; // filter type: none
    const my = Math.floor(y / scale) - quiet;
    if (my < 0 || my >= qr.size) continue;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      if (mx < 0 || mx >= qr.size) continue;
      if (qr.modules[my][mx]) raw[y * (dim + 1) + 1 + x] = 0x00;
    }
  }

  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = buf => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  // 10-12 stay 0: deflate, adaptive filtering, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const url = process.argv[2] || DEFAULT_URL;
const quiet = 4;   // the spec's minimum quiet zone; do not shrink it for print
const scale = 20;  // px per module -> plenty of resolution for A4/A5

const qr = makeQr(url, ECC_LEVEL);
const outDir = __dirname;

fs.writeFileSync(path.join(outDir, 'mobo-qr.svg'), toSvg(qr, quiet));
fs.writeFileSync(path.join(outDir, 'mobo-qr.png'), toPng(qr, quiet, scale));

const px = (qr.size + quiet * 2) * scale;
console.log(`URL      : ${url}`);
console.log(`Version  : ${qr.version}  (${qr.size}x${qr.size} modules, mask ${qr.mask}, ECC level Q)`);
console.log(`Written  : mobo-qr.svg (vector) and mobo-qr.png (${px}x${px}px)`);
