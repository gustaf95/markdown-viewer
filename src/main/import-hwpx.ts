import * as fs from 'fs';
import { readZip } from './zip';

// ---------------------------------------------------------------------------
// HWPX 파일 열기 (F-1201)
//  - DOCX와 마찬가지로 main은 ZIP만 풀고 해석은 renderer가 한다.
//  - 본문은 Contents/section0.xml, section1.xml ... 로 나뉠 수 있다.
//  - 이미지는 BinData/에 들어 있고, 어떤 파일인지는 Contents/content.hpf의
//    <opf:item id="image1" href="BinData/image1.png">가 알려 준다.
// ---------------------------------------------------------------------------

/** renderer로 넘길 HWPX 부품들 */
export interface HwpxParts {
  /** Contents/section*.xml — 쪽 순서대로 */
  sections: string[];
  /** Contents/header.xml — 글자/문단 모양 목록 */
  header?: string;
  /** binaryItemIDRef -> data URI */
  media?: Record<string, string>;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function text(entries: Map<string, Buffer>, name: string): string | undefined {
  const buf = entries.get(name);
  return buf ? buf.toString('utf8') : undefined;
}

/**
 * content.hpf에서 `id -> BinData 파일명`을 뽑는다.
 * main에는 XML 파서가 없어 정규식으로 읽는다 — 속성 하나만 보면 되므로 충분하다.
 */
function readBinaryIds(hpf: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!hpf) return map;
  const itemRe = /<opf:item\b[^>]*>/g;
  for (const tag of hpf.match(itemRe) ?? []) {
    const id = /\bid="([^"]*)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1];
    if (id && href && href.startsWith('BinData/')) map.set(id, href.slice('BinData/'.length));
  }
  return map;
}

/**
 * .hwpx 파일을 읽어 renderer가 해석할 수 있는 부품으로 나눈다.
 * section0.xml이 없으면 HWPX가 아니라고 보고 예외를 던진다.
 */
export function readHwpx(filePath: string): HwpxParts {
  const entries = readZip(fs.readFileSync(filePath));

  // section0, section1, ... 순서대로 모은다
  const sectionNames = Array.from(entries.keys())
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const num = (s: string): number => Number(/section(\d+)/i.exec(s)?.[1] ?? '0');
      return num(a) - num(b);
    });
  if (sectionNames.length === 0) throw new Error('한글 문서가 아니거나 본문을 찾을 수 없습니다.');

  const binaryIds = readBinaryIds(text(entries, 'Contents/content.hpf'));
  const media: Record<string, string> = {};
  for (const [id, fileName] of binaryIds) {
    const data = entries.get(`BinData/${fileName}`);
    if (!data || data.length > MAX_IMAGE_BYTES) continue;
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    media[id] = `data:${mime};base64,${data.toString('base64')}`;
  }

  return {
    sections: sectionNames.map((name) => text(entries, name) ?? ''),
    header: text(entries, 'Contents/header.xml'),
    media,
  };
}
