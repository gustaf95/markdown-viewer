import * as zlib from 'zlib';

// ---------------------------------------------------------------------------
// 최소 ZIP 작성기 (F-1103)
//  - HWPX는 OWPML XML들을 ZIP으로 묶은 형식이라 압축기가 필요한데,
//    이것 하나 때문에 의존성을 늘리지 않으려고 직접 만들었다.
//  - HWPX는 ODF 계열처럼 `mimetype`이 **무압축(STORED)으로 맨 앞**에 와야 하므로
//    항목별로 압축 여부를 고를 수 있게 했다.
//  - ZIP64는 다루지 않는다. 문서 하나가 4GB를 넘을 일은 없다.
// ---------------------------------------------------------------------------

export interface ZipEntry {
  /** ZIP 안에서의 경로 (항상 '/' 구분자) */
  name: string;
  data: Buffer;
  /** false면 무압축으로 저장 (mimetype 전용) */
  deflate?: boolean;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 항목들을 ZIP 한 덩어리로 묶는다.
 * 타임스탬프는 1980-01-01로 고정한다 — 같은 문서를 내보내면 같은 바이트가 나와
 * 결과를 비교하기 쉽고, 한글도 날짜를 보지 않는다.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const useDeflate = entry.deflate !== false;
    const stored = useDeflate ? zlib.deflateRawSync(entry.data, { level: 9 }) : entry.data;
    // 압축했는데 오히려 커지면 무압축으로 (작은 XML에서 종종 생긴다)
    const compressed = useDeflate && stored.length < entry.data.length;
    const body = compressed ? stored : entry.data;
    const method = compressed ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 필요 버전 2.0
    local.writeUInt16LE(0x0800, 6); // 파일명이 UTF-8임을 알리는 플래그
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 시각
    local.writeUInt16LE(0x0021, 12); // 날짜 = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 만든 버전
    central.writeUInt16LE(20, 6); // 필요 버전
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 디스크 번호
    central.writeUInt16LE(0, 36); // 내부 속성
    central.writeUInt32LE(0, 38); // 외부 속성
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}
