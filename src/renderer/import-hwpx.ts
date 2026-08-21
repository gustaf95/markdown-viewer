import type {
  DocBlock,
  DocInline,
  DocListItem,
  DocModel,
  DocTableCell,
  DocText,
} from '../common/docmodel';
import { hwpEquationToLatex } from '../common/hwp-eqn-to-latex';

// ---------------------------------------------------------------------------
// HWPX(OWPML) -> DocModel (F-1201)
//  - main이 ZIP을 풀어 넘긴 XML을 DOMParser로 읽는다 (DOCX 가져오기와 같은 구조).
//  - 한글은 서식을 문단·글자에 직접 적지 않고 header.xml의 목록을 번호로 가리키므로,
//    먼저 그 목록을 읽어 두고 본문에서 번호로 찾아 쓴다.
//  - 제목·목록·코드 블록은 한글 문서에 그런 표시가 없어 **모양으로 추정**한다.
//    우리가 내보낸 문서는 규칙이 일정해 잘 맞고, 남이 만든 문서는 덜 맞는다.
// ---------------------------------------------------------------------------

export interface HwpxParts {
  filePath: string;
  sections: string[];
  header?: string;
  media?: Record<string, string>;
}

/** 본문 글자 크기 (1/100 pt). 내보내기와 같은 값 */
const BODY_SIZE = 1050;
/** 이 크기 이상이면서 굵으면 제목으로 본다 */
const HEADING_SIZES = [2000, 1600, 1400, 1200, 1100];

const MONO_FONTS = /d2coding|consolas|courier|monaco|menlo|나눔고딕코딩/i;

function localName(el: Element): string {
  return el.localName.toLowerCase();
}

function kids(el: Element): Element[] {
  return Array.from(el.children);
}

function firstChild(el: Element, name: string): Element | undefined {
  return kids(el).find((c) => localName(c) === name);
}

function descendants(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => localName(el) === name);
}

function parseXml(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
}

// ---------------------------------------------------------------------------
// header.xml — 글자/문단 모양 목록
// ---------------------------------------------------------------------------
interface CharShape {
  size: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  mono: boolean;
  /** 배경 음영 (인라인 코드 판별) */
  shaded: boolean;
}

interface ParaShape {
  align: string;
  /** 왼쪽 들여쓰기 (HWPUNIT) */
  left: number;
  borderFill: number;
}

interface HeaderInfo {
  chars: Map<number, CharShape>;
  paras: Map<number, ParaShape>;
  /** borderFill id -> 배경색이 있는가 (코드 블록 판별) */
  filled: Set<number>;
  /** 왼쪽 세로줄이 있는가 (인용문 판별) */
  leftBorder: Set<number>;
  /** 아래 가로줄만 있는가 (수평선 판별) */
  bottomOnly: Set<number>;
  /** styleIDRef -> 스타일 이름 */
  styles: Map<number, string>;
}

function readHeader(xml: string | undefined): HeaderInfo {
  const info: HeaderInfo = {
    chars: new Map(),
    paras: new Map(),
    filled: new Set(),
    leftBorder: new Set(),
    bottomOnly: new Set(),
    styles: new Map(),
  };
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return info;

  // 언어별 글꼴 목록 — 라틴 자리만 봐도 고정폭 여부를 알 수 있다
  const monoFontIds = new Set<number>();
  for (const face of descendants(doc, 'fontface')) {
    for (const font of kids(face)) {
      if (localName(font) !== 'font') continue;
      const id = Number(font.getAttribute('id') ?? '-1');
      if (MONO_FONTS.test(font.getAttribute('face') ?? '')) monoFontIds.add(id);
    }
  }

  for (const charPr of descendants(doc, 'charpr')) {
    const id = Number(charPr.getAttribute('id') ?? '-1');
    if (id < 0) continue;
    const fontRef = firstChild(charPr, 'fontref');
    const fontId = Number(fontRef?.getAttribute('latin') ?? fontRef?.getAttribute('hangul') ?? '0');
    const shade = charPr.getAttribute('shadeColor') ?? 'none';
    info.chars.set(id, {
      size: Number(charPr.getAttribute('height') ?? BODY_SIZE),
      bold: firstChild(charPr, 'bold') !== undefined,
      italic: firstChild(charPr, 'italic') !== undefined,
      strike: (firstChild(charPr, 'strikeout')?.getAttribute('shape') ?? 'NONE') !== 'NONE',
      underline: (firstChild(charPr, 'underline')?.getAttribute('type') ?? 'NONE') !== 'NONE',
      mono: monoFontIds.has(fontId),
      shaded: shade !== 'none' && shade !== '' && shade.toUpperCase() !== '#FFFFFF',
    });
  }

  for (const paraPr of descendants(doc, 'parapr')) {
    const id = Number(paraPr.getAttribute('id') ?? '-1');
    if (id < 0) continue;
    // margin/left 는 hp:switch 안에 들어 있을 수 있어 후손에서 찾는다
    const left = descendants(paraPr, 'left')[0];
    info.paras.set(id, {
      align: firstChild(paraPr, 'align')?.getAttribute('horizontal') ?? 'JUSTIFY',
      left: Number(left?.getAttribute('value') ?? '0'),
      borderFill: Number(firstChild(paraPr, 'border')?.getAttribute('borderFillIDRef') ?? '0'),
    });
  }

  for (const fill of descendants(doc, 'borderfill')) {
    const id = Number(fill.getAttribute('id') ?? '-1');
    if (id < 0) continue;
    const brush = descendants(fill, 'winbrush')[0];
    const face = brush?.getAttribute('faceColor') ?? 'none';
    if (face !== 'none' && face !== '') info.filled.add(id);

    // 테두리는 있고/없고가 아니라 어느 변에 있는지를 봐야 한다.
    // 기본 문단도 borderFill을 가리키지만 네 변이 모두 NONE이다.
    const side = (name: string): boolean =>
      (firstChild(fill, name)?.getAttribute('type') ?? 'NONE') !== 'NONE';
    const left = side('leftborder');
    const bottom = side('bottomborder');
    if (left) info.leftBorder.add(id);
    if (bottom && !left && !side('topborder') && !side('rightborder')) info.bottomOnly.add(id);
  }

  for (const style of descendants(doc, 'style')) {
    const id = Number(style.getAttribute('id') ?? '-1');
    const name = style.getAttribute('name') ?? '';
    if (id >= 0 && name) info.styles.set(id, name);
  }

  return info;
}

// ---------------------------------------------------------------------------
// 본문 읽기
// ---------------------------------------------------------------------------
/** 우리가 내보낼 때 찍은 글머리 기호 — 되읽어 목록으로 되돌린다 */
const BULLET_RE = /^([•◦▪·]|[-*])\s+/;
const ORDERED_RE = /^(\d+)[.)]\s+/;
const CHECK_RE = /^([☑☒])\s+/;
const UNCHECK_RE = /^(☐)\s+/;

/** HWPUNIT -> 목록 깊이. 내보내기는 수준마다 5mm씩 들여썼다 */
const INDENT_PER_LEVEL = (7200 / 25.4) * 5;

class HwpxReader {
  constructor(
    private readonly header: HeaderInfo,
    private readonly media: Record<string, string>,
  ) {}

  private charShape(el: Element): CharShape | undefined {
    const id = Number(el.getAttribute('charPrIDRef') ?? '-1');
    return id >= 0 ? this.header.chars.get(id) : undefined;
  }

  /** hp:run 하나 -> 인라인 조각들 */
  private run(el: Element): DocInline[] {
    const shape = this.charShape(el);
    const out: DocInline[] = [];

    for (const c of kids(el)) {
      const name = localName(c);
      if (name === 't') {
        const text = c.textContent ?? '';
        if (text.length === 0) continue;
        const run: DocText = { kind: 'text', text };
        if (shape) {
          if (shape.bold) run.bold = true;
          if (shape.italic) run.italic = true;
          if (shape.strike) run.strike = true;
          if (shape.mono && shape.shaded) run.code = true;
        }
        out.push(run);
      } else if (name === 'equation') {
        const script = firstChild(c, 'script')?.textContent ?? '';
        const tex = script ? hwpEquationToLatex(script) : null;
        if (tex) out.push({ kind: 'math', math: { tag: 'math' }, tex });
        else if (script) {
          // 읽지 못한 수식은 원본 스크립트를 코드로 남긴다 (내용을 잃지 않도록)
          out.push({ kind: 'text', text: script, code: true });
        }
      } else if (name === 'pic') {
        const img = descendants(c, 'img')[0];
        const id = img?.getAttribute('binaryItemIDRef') ?? '';
        const src = this.media[id];
        if (src) out.push({ kind: 'image', src, alt: '', width: 0, height: 0 });
      }
    }
    return out;
  }

  /** 문단 안의 글자 조각들 (표·수식 포함) */
  private inlines(el: Element): DocInline[] {
    const out: DocInline[] = [];
    for (const c of kids(el)) {
      if (localName(c) === 'run') out.push(...this.run(c));
    }
    return out;
  }

  /** 문단이 표 하나만 담고 있으면 그 표 요소 */
  private tableOf(el: Element): Element | undefined {
    for (const run of kids(el)) {
      if (localName(run) !== 'run') continue;
      const tbl = firstChild(run, 'tbl');
      if (tbl) return tbl;
    }
    return undefined;
  }

  paraShape(el: Element): ParaShape | undefined {
    const id = Number(el.getAttribute('paraPrIDRef') ?? '-1');
    return id >= 0 ? this.header.paras.get(id) : undefined;
  }

  /** 문단 -> 블록 또는 목록 항목 */
  paragraph(el: Element): { block?: DocBlock; item?: DocListItem; code?: DocText[] } {
    const table = this.tableOf(el);
    if (table) return { block: this.table(table) ?? undefined };

    const inlines = this.inlines(el);
    const shape = this.paraShape(el);
    const styleName = this.header.styles.get(Number(el.getAttribute('styleIDRef') ?? '-1')) ?? '';

    // 코드 블록: 배경이 있는 문단 + 고정폭 글자
    const inCodeBlock = shape !== undefined && this.header.filled.has(shape.borderFill);
    if (inCodeBlock) {
      const runs = inlines.filter((c): c is DocText => c.kind === 'text');
      return { code: runs.length > 0 ? runs : [{ kind: 'text', text: '' }] };
    }

    if (inlines.length === 0) {
      // 글자 없이 아래 가로줄만 있는 문단은 수평선이다
      if (shape && this.header.bottomOnly.has(shape.borderFill)) return { block: { kind: 'rule' } };
      return {};
    }

    // 수식만 있는 문단 -> 블록 수식
    const meaningful = inlines.filter((c) => !(c.kind === 'text' && c.text.trim().length === 0));
    if (meaningful.length === 1 && meaningful[0].kind === 'math') {
      const math = meaningful[0];
      return { block: { kind: 'mathblock', math: math.math, tex: math.tex } };
    }
    if (meaningful.length === 1 && meaningful[0].kind === 'image') {
      const image = meaningful[0];
      return { block: { kind: 'imageblock', src: image.src, alt: image.alt, width: 0, height: 0 } };
    }

    // 제목 판별을 목록보다 먼저 한다.
    // `## 1. 물리 공식 정리` 처럼 제목 글자가 "1. "로 시작하면 번호 목록으로 오인하기 때문이다.
    const styleHeading = /^(개요|제목|heading)\s*([1-6])$/i.exec(styleName.trim());
    if (styleHeading) {
      return { block: { kind: 'heading', level: Number(styleHeading[2]), children: inlines } };
    }
    const headingLevel = this.headingBySize(el);
    if (headingLevel) return { block: { kind: 'heading', level: headingLevel, children: inlines } };

    // 목록: 첫 글자가 글머리 기호이면 벗겨 낸다
    const first = inlines[0];
    if (first?.kind === 'text') {
      const level = shape ? Math.round(shape.left / INDENT_PER_LEVEL) - 1 : 0;
      const check = CHECK_RE.exec(first.text) ?? UNCHECK_RE.exec(first.text);
      if (check) {
        return {
          item: {
            level: Math.max(0, level),
            ordered: false,
            checked: CHECK_RE.test(first.text),
            children: stripMarker(inlines, check[0].length),
          },
        };
      }
      const ordered = ORDERED_RE.exec(first.text);
      if (ordered) {
        return { item: { level: Math.max(0, level), ordered: true, children: stripMarker(inlines, ordered[0].length) } };
      }
      const bullet = BULLET_RE.exec(first.text);
      if (bullet) {
        return { item: { level: Math.max(0, level), ordered: false, children: stripMarker(inlines, bullet[0].length) } };
      }
    }

    // 인용문: 왼쪽 세로줄이 있는 문단 (배경은 없다 — 배경이 있으면 코드 블록이다)
    const quote = shape !== undefined && this.header.leftBorder.has(shape.borderFill);
    return { block: { kind: 'paragraph', children: inlines, quote: quote || undefined } };
  }

  /** 글자 크기와 굵기로 제목 단계를 추정한다 */
  private headingBySize(el: Element): number | undefined {
    for (const run of kids(el)) {
      if (localName(run) !== 'run') continue;
      const shape = this.charShape(run);
      if (!shape || !shape.bold || shape.size <= BODY_SIZE) continue;
      const index = HEADING_SIZES.findIndex((size) => shape.size >= size);
      return index >= 0 ? index + 1 : 6;
    }
    return undefined;
  }

  table(el: Element): DocBlock | null {
    const rows: DocTableCell[][] = [];
    for (const tr of kids(el)) {
      if (localName(tr) !== 'tr') continue;
      const cells: DocTableCell[] = [];
      for (const tc of kids(tr)) {
        if (localName(tc) !== 'tc') continue;
        const sub = firstChild(tc, 'sublist');
        const children: DocInline[] = [];
        let align: DocTableCell['align'];
        if (sub) {
          const paragraphs = kids(sub).filter((c) => localName(c) === 'p');
          paragraphs.forEach((p, index) => {
            if (index > 0) children.push({ kind: 'break' });
            children.push(...this.inlines(p));
            if (index === 0) {
              const horizontal = this.paraShape(p)?.align;
              if (horizontal === 'CENTER') align = 'center';
              else if (horizontal === 'RIGHT') align = 'right';
            }
          });
        }
        cells.push({ children, align, header: tc.getAttribute('header') === '1' ? true : undefined });
      }
      if (cells.length > 0) rows.push(cells);
    }
    return rows.length > 0 ? { kind: 'table', rows } : null;
  }
}

/** 글머리 기호를 벗겨 낸 인라인 목록 */
function stripMarker(inlines: readonly DocInline[], length: number): DocInline[] {
  const out = inlines.slice();
  const first = out[0];
  if (first?.kind === 'text') {
    const text = first.text.slice(length);
    if (text.length === 0) out.shift();
    else out[0] = { ...first, text };
  }
  return out;
}

/**
 * HWPX 부품들 -> DocModel.
 * 본문을 읽지 못하면 예외를 던진다.
 */
export function hwpxToDocModel(parts: HwpxParts, title: string): DocModel {
  const header = readHeader(parts.header);
  const reader = new HwpxReader(header, parts.media ?? {});
  const blocks: DocBlock[] = [];

  let listItems: DocListItem[] = [];
  let codeRuns: DocText[][] = [];
  const flushList = (): void => {
    if (listItems.length > 0) blocks.push({ kind: 'list', items: listItems });
    listItems = [];
  };
  const flushCode = (): void => {
    if (codeRuns.length > 0) blocks.push({ kind: 'code', lines: codeRuns.map((runs) => ({ runs })) });
    codeRuns = [];
  };

  let parsedAny = false;
  for (const xml of parts.sections) {
    const doc = parseXml(xml);
    if (!doc) continue;
    parsedAny = true;
    for (const p of descendants(doc, 'p')) {
      // 표 칸 안의 문단은 표를 읽을 때 함께 처리하므로 여기서 건너뛴다
      if (p.parentElement && localName(p.parentElement) === 'sublist') continue;

      const { block, item, code } = reader.paragraph(p);
      if (code) { flushList(); codeRuns.push(code); continue; }
      flushCode();
      if (item) { listItems.push(item); continue; }
      flushList();
      if (block) blocks.push(block);
    }
  }
  flushCode();
  flushList();

  if (!parsedAny) throw new Error('본문 XML을 읽지 못했습니다. 손상된 파일일 수 있습니다.');
  return { title, blocks };
}
