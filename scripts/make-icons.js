/**
 * assets/markdown-viewer-icon.png (2048x2048, 흰 배경 RGB) 을
 * 다중 해상도 아이콘 assets/icon.ico 로 변환한다.
 * 앱 아이콘과 .md 파일 연결 아이콘 모두 이 파일을 쓴다.
 *
 *  1) 흰 배경/그림자를 가장자리에서 flood fill 로 지워 둥근 모서리를 투명하게 만든다
 *  2) 각 아이콘 크기로 area-average 축소 (premultiplied alpha 로 계산해 가장자리 흰 테두리 방지)
 *  3) 큰 크기는 PNG, 48px 이하는 BMP(DIB) 로 담아 ICO 컨테이너로 묶는다
 *     (48px 이하를 BMP 로 두는 것이 구형 탐색기 뷰까지 안전하다)
 *
 * 사용: npm run make:icons
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const assets = path.join(__dirname, '..', 'assets');
const SOURCE = path.join(assets, 'markdown-viewer-icon.png');
const OUTPUT = path.join(assets, 'icon.ico');
const PREVIEW = path.join(assets, 'icon-256.png');
const SIZES = [256, 128, 64, 48, 32, 24, 16];
/** 이 크기 이하는 BMP(DIB) 로 저장 */
const BMP_MAX = 48;

// ---------------------------------------------------------------------------
// PNG 디코딩 (8bit, non-interlaced, color type 0/2/4/6)
// ---------------------------------------------------------------------------
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 파일이 아닙니다: ' + file);
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('IHDR 청크가 없습니다');
  if (ihdr.depth !== 8) throw new Error(`8bit PNG만 지원합니다 (depth=${ihdr.depth})`);
  if (ihdr.interlace) throw new Error('interlaced PNG 는 지원하지 않습니다');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`지원하지 않는 color type ${ihdr.color} (팔레트 PNG)`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const un = Buffer.alloc(ihdr.height * stride);
  let p = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const rv = raw[p + x];
      const a = x >= channels ? un[row + x - channels] : 0;
      const b = y > 0 ? un[prev + x] : 0;
      const c = x >= channels && y > 0 ? un[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + b; break;
        case 3: v = rv + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = rv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('알 수 없는 PNG filter ' + filter);
      }
      un[row + x] = v & 0xff;
    }
    p += stride;
  }

  const data = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, n = ihdr.width * ihdr.height; i < n; i++) {
    const s = i * channels, d = i * 4;
    if (channels === 4) { data[d] = un[s]; data[d + 1] = un[s + 1]; data[d + 2] = un[s + 2]; data[d + 3] = un[s + 3]; }
    else if (channels === 3) { data[d] = un[s]; data[d + 1] = un[s + 1]; data[d + 2] = un[s + 2]; data[d + 3] = 255; }
    else if (channels === 2) { data[d] = data[d + 1] = data[d + 2] = un[s]; data[d + 3] = un[s + 1]; }
    else { data[d] = data[d + 1] = data[d + 2] = un[s]; data[d + 3] = 255; }
  }
  return { width: ihdr.width, height: ihdr.height, data };
}

// ---------------------------------------------------------------------------
// 배경 제거: 가장자리에서 시작해 "밝고 무채색"인 픽셀만 flood fill 로 투명화.
// 아이콘 안쪽의 흰 문서는 파란 테두리로 둘러싸여 있어 fill 이 닿지 않는다.
// ---------------------------------------------------------------------------
function clearBackground(img, { minLuma = 226, maxChroma = 14 } = {}) {
  const { width: w, height: h, data } = img;
  const isBackground = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const min = Math.min(r, g, b);
    return min >= minLuma && Math.max(r, g, b) - min <= maxChroma;
  };

  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const push = (px) => {
    if (visited[px]) return;
    visited[px] = 1;
    if (!isBackground(px * 4)) return; // 방문 표시만 하고 확장하지 않음
    stack[top++] = px;
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

  let cleared = 0;
  while (top > 0) {
    const px = stack[--top];
    data[px * 4 + 3] = 0;
    cleared++;
    const x = px % w, y = (px - x) / w;
    if (x > 0) push(px - 1);
    if (x < w - 1) push(px + 1);
    if (y > 0) push(px - w);
    if (y < h - 1) push(px + w);
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// area-average 축소 (premultiplied alpha)
// ---------------------------------------------------------------------------
function resize(img, size) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const sx = sw / size, sy = sh / size;
  for (let dy = 0; dy < size; dy++) {
    const y0 = dy * sy, y1 = y0 + sy;
    const iy0 = Math.floor(y0), iy1 = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let dx = 0; dx < size; dx++) {
      const x0 = dx * sx, x1 = x0 + sx;
      const ix0 = Math.floor(x0), ix1 = Math.min(sw - 1, Math.ceil(x1) - 1);
      let ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0;
      for (let y = iy0; y <= iy1; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = ix0; x <= ix1; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const i = (y * sw + x) * 4;
          const a = data[i + 3] / 255;
          ar += data[i] * a * wgt;
          ag += data[i + 1] * a * wgt;
          ab += data[i + 2] * a * wgt;
          aa += a * wgt;
          wsum += wgt;
        }
      }
      const d = (dy * size + dx) * 4;
      if (aa > 0) {
        out[d] = Math.round(ar / aa);
        out[d + 1] = Math.round(ag / aa);
        out[d + 2] = Math.round(ab / aa);
        out[d + 3] = Math.round((aa / wsum) * 255);
      }
    }
  }
  return { width: size, height: size, data: out };
}

/**
 * 2048px 원본을 작은 크기로 area-average 하면 획이 뭉개지므로 언샤프 마스크로 살린다.
 * 알파는 건드리지 않는다 (가장자리에 링잉이 생겨 둥근 모서리가 지저분해짐).
 */
function sharpen(img, amount) {
  const { width: w, height: h, data } = img;
  const src = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      if (src[d + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[(yy * w + xx) * 4 + ch];
            n++;
          }
        }
        const v = src[d + ch] + amount * (src[d + ch] - sum / n);
        data[d + ch] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// PNG 인코딩
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const { width: w, height: h, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO 안에 들어가는 BMP(DIB): 32bpp BGRA 상하 반전 + AND 마스크
// ---------------------------------------------------------------------------
function encodeDib(img) {
  const { width: w, height: h, data } = img;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR + AND 를 합친 높이
  header.writeUInt16LE(1, 12);   // planes
  header.writeUInt16LE(32, 14);  // bpp
  const xor = Buffer.alloc(w * h * 4);
  const maskStride = Math.ceil(w / 8 / 4) * 4;
  const and = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // 아래에서 위로
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      const d = (y * w + x) * 4;
      xor[d] = data[s + 2];
      xor[d + 1] = data[s + 1];
      xor[d + 2] = data[s];
      xor[d + 3] = data[s + 3];
      if (data[s + 3] === 0) and[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([header, xor, and]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);   // planes
    dir.writeUInt16LE(32, o + 6);  // bpp
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------------------
if (!fs.existsSync(SOURCE)) {
  console.error(`원본 이미지가 없습니다: ${SOURCE}`);
  process.exit(1);
}
const src = decodePng(SOURCE);
const cleared = clearBackground(src);
const ratio = ((cleared / (src.width * src.height)) * 100).toFixed(1);
console.log(`원본 ${src.width}x${src.height}, 배경 제거 ${cleared}px (${ratio}%)`);
if (cleared === 0) console.warn('경고: 투명 처리된 배경이 없습니다. 원본 배경색을 확인하세요.');
if (cleared / (src.width * src.height) > 0.5) console.warn('경고: 배경이 과하게 지워졌습니다. flood fill 임계값을 확인하세요.');

const entries = SIZES.map((size) => {
  const scaled = resize(src, size);
  if (size <= 64) sharpen(scaled, size <= 32 ? 0.8 : 0.5);
  const data = size <= BMP_MAX ? encodeDib(scaled) : encodePng(scaled);
  if (size === 256) fs.writeFileSync(PREVIEW, encodePng(scaled));
  return { size, data };
});

fs.writeFileSync(OUTPUT, buildIco(entries));
console.log(`created ${path.relative(process.cwd(), OUTPUT)} (${SIZES.join(', ')}px, ${fs.statSync(OUTPUT).size.toLocaleString()} bytes)`);
console.log(`created ${path.relative(process.cwd(), PREVIEW)} (미리보기)`);
