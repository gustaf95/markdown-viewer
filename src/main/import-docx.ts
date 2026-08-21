import * as fs from 'fs';
import { readZip } from './zip';

// ---------------------------------------------------------------------------
// DOCX 파일 열기 (F-1201)
//  - main은 ZIP을 풀어 XML 문자열과 이미지만 꺼낸다. 해석은 renderer가 한다
//    (main에는 XML 파서가 없고, renderer는 sandbox라 파일을 못 읽는다).
//  - 내보내기에서 "DOM 해석은 renderer, 파일 처리는 main"으로 나눈 것과 대칭이다.
// ---------------------------------------------------------------------------

/** renderer로 넘길 DOCX 부품들 */
export interface DocxParts {
  document: string;
  styles?: string;
  numbering?: string;
  rels?: string;
  /** 파일명 -> data URI */
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

/** 이미지 하나가 너무 크면 넘기지 않는다 (IPC로 실어 나르는 비용) */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function text(entries: Map<string, Buffer>, name: string): string | undefined {
  const buf = entries.get(name);
  return buf ? buf.toString('utf8') : undefined;
}

/**
 * .docx 파일을 읽어 renderer가 해석할 수 있는 부품으로 나눈다.
 * document.xml이 없으면 DOCX가 아니라고 보고 예외를 던진다.
 */
export function readDocx(filePath: string): DocxParts {
  const entries = readZip(fs.readFileSync(filePath));
  const document = text(entries, 'word/document.xml');
  if (!document) throw new Error('Word 문서가 아니거나 본문을 찾을 수 없습니다.');

  const media: Record<string, string> = {};
  for (const [name, data] of entries) {
    if (!name.startsWith('word/media/')) continue;
    if (data.length > MAX_IMAGE_BYTES) continue;
    const fileName = name.slice('word/media/'.length);
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    media[fileName] = `data:${mime};base64,${data.toString('base64')}`;
  }

  return {
    document,
    styles: text(entries, 'word/styles.xml'),
    numbering: text(entries, 'word/numbering.xml'),
    rels: text(entries, 'word/_rels/document.xml.rels'),
    media,
  };
}
