import type {
  DocBlock,
  DocInline,
  DocListItem,
  DocModel,
  DocTableCell,
  DocText,
} from '../common/docmodel';
import { ommlToLatex } from '../common/omml-to-latex';

// ---------------------------------------------------------------------------
// DOCX(WordprocessingML) -> DocModel (F-1201)
//  - main이 ZIP을 풀어 넘긴 XML 문자열을 DOMParser로 읽는다.
//    renderer는 sandbox라 파일을 못 읽고, main에는 XML 파서가 없다.
//    내보내기에서 "DOM 해석은 renderer, 파일 처리는 main"으로 나눈 것과 같은 이유다.
//  - 네임스페이스 접두사는 문서마다 다를 수 있으므로 localName만 본다.
//  - 알아보지 못하는 요소를 만나도 멈추지 않고 건너뛴다 (F-1208).
// ---------------------------------------------------------------------------

/** main이 넘겨주는 DOCX 부품들 */
export interface DocxParts {
  /** word/document.xml */
  document: string;
  /** word/styles.xml (제목 스타일 판별용) */
  styles?: string;
  /** word/numbering.xml (번호 목록 판별용) */
  numbering?: string;
  /** word/media/* 를 파일명 -> data URI 로 */
  media?: Record<string, string>;
  /** 관계 파일 (r:embed -> media 파일명) */
  rels?: string;
}

function localName(el: Element): string {
  return el.localName.toLowerCase();
}

function kids(el: Element): Element[] {
  return Array.from(el.children);
}

function firstChild(el: Element, name: string): Element | undefined {
  return kids(el).find((c) => localName(c) === name);
}

/** w:val 같은 값 속성 (접두사 무시) */
function attrValue(el: Element | undefined, suffix = 'val'): string | undefined {
  if (!el) return undefined;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().endsWith(suffix.toLowerCase())) return attr.value;
  }
  return undefined;
}

function parseXml(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
}

// ---------------------------------------------------------------------------
// 스타일 표: 제목 단계를 알아내기 위한 것
// ---------------------------------------------------------------------------
interface StyleInfo {
  /** 1~6, 제목이 아니면 undefined */
  heading?: number;
  /** 고정폭 글꼴이면 코드로 본다 */
  mono?: boolean;
}

const MONO_FONTS = /consolas|courier|d2coding|monaco|menlo|나눔고딕코딩/i;

function readStyles(xml: string | undefined): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return map;
  for (const style of Array.from(doc.getElementsByTagName('*'))) {
    if (localName(style) !== 'style') continue;
    const id = attrValue(style, 'styleId');
    if (!id) continue;
    const name = attrValue(firstChild(style, 'name')) ?? '';
    const info: StyleInfo = {};
    // Word는 "heading 1" / "제목 1" 둘 다 쓴다. outlineLvl 도 함께 본다
    const heading = /^(heading|제목)\s*([1-6])$/i.exec(name.trim());
    if (heading) info.heading = Number(heading[2]);
    else if (/^(heading|제목)([1-6])$/i.test(id)) info.heading = Number(id.slice(-1));
    const fonts = firstChild(firstChild(style, 'rpr') ?? style, 'rfonts');
    if (fonts && MONO_FONTS.test(Array.from(fonts.attributes).map((a) => a.value).join(' '))) info.mono = true;
    if (info.heading !== undefined || info.mono) map.set(id, info);
  }
  return map;
}

/** 관계 id -> media 파일명 */
function readRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return map;
  for (const rel of Array.from(doc.getElementsByTagName('*'))) {
    if (localName(rel) !== 'relationship') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map.set(id, target.replace(/^.*\//, ''));
  }
  return map;
}

/** 번호 매김 id -> 순서 있는 목록인지 */
function readNumbering(xml: string | undefined): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const doc = xml ? parseXml(xml) : null;
  if (!doc) return map;
  // abstractNumId -> 수준 0의 numFmt
  const ordered = new Map<string, boolean>();
  for (const abstract of Array.from(doc.getElementsByTagName('*'))) {
    if (localName(abstract) !== 'abstractnum') continue;
    const id = attrValue(abstract, 'abstractNumId');
    const level = kids(abstract).find((c) => localName(c) === 'lvl');
    const format = attrValue(firstChild(level ?? abstract, 'numfmt'));
    if (id) ordered.set(id, format !== undefined && format !== 'bullet' && format !== 'none');
  }
  for (const num of Array.from(doc.getElementsByTagName('*'))) {
    if (localName(num) !== 'num') continue;
    const numId = attrValue(num, 'numId');
    const abstractId = attrValue(firstChild(num, 'abstractnumid'));
    if (numId && abstractId) map.set(numId, ordered.get(abstractId) ?? false);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 인라인
// ---------------------------------------------------------------------------
class DocxReader {
  constructor(
    private readonly styles: Map<string, StyleInfo>,
    private readonly rels: Map<string, string>,
    private readonly numbering: Map<string, boolean>,
    private readonly media: Record<string, string>,
  ) {}

  /** 하나의 w:r (글자 조각) */
  private run(el: Element): DocInline[] {
    const props = firstChild(el, 'rpr');
    const out: DocInline[] = [];
    let text = '';

    const flush = (): void => {
      if (text.length === 0) return;
      const run: DocText = { kind: 'text', text };
      if (props) {
        if (firstChild(props, 'b') && attrValue(firstChild(props, 'b')) !== '0') run.bold = true;
        if (firstChild(props, 'i') && attrValue(firstChild(props, 'i')) !== '0') run.italic = true;
        const strike = firstChild(props, 'strike');
        if (strike && attrValue(strike) !== '0') run.strike = true;
        const fonts = firstChild(props, 'rfonts');
        if (fonts && MONO_FONTS.test(Array.from(fonts.attributes).map((a) => a.value).join(' '))) run.code = true;
      }
      out.push(run);
      text = '';
    };

    for (const c of kids(el)) {
      const name = localName(c);
      if (name === 't') text += c.textContent ?? '';
      else if (name === 'tab') text += '\t';
      else if (name === 'br') { flush(); out.push({ kind: 'break' }); }
      else if (name === 'drawing' || name === 'pict') { flush(); const img = this.image(c); if (img) out.push(img); }
    }
    flush();
    return out;
  }

  /** 그림: r:embed 관계 id로 media를 찾는다 */
  private image(el: Element): DocInline | null {
    for (const node of Array.from(el.getElementsByTagName('*'))) {
      for (const attr of Array.from(node.attributes)) {
        if (!/(embed|link|id)$/i.test(attr.name)) continue;
        const file = this.rels.get(attr.value);
        const src = file ? this.media[file] : undefined;
        if (src) return { kind: 'image', src, alt: file ?? '', width: 0, height: 0 };
      }
    }
    return null;
  }

  /** 문단 안의 요소들 -> DocInline[] (수식 포함) */
  private inlines(el: Element): DocInline[] {
    const out: DocInline[] = [];
    for (const c of kids(el)) {
      const name = localName(c);
      if (name === 'r') out.push(...this.run(c));
      else if (name === 'hyperlink') {
        const children: DocInline[] = [];
        for (const inner of kids(c)) if (localName(inner) === 'r') children.push(...this.run(inner));
        if (children.length > 0) out.push({ kind: 'link', href: '', children });
      } else if (name === 'omath' || name === 'omathpara') {
        // 수식: OMML -> LaTeX. DocMath는 MathML을 담으므로 tex만 채운다
        const target = name === 'omathpara' ? (firstChild(c, 'omath') ?? c) : c;
        const tex = ommlToLatex(target);
        if (tex) out.push({ kind: 'math', math: { tag: 'math' }, tex });
      } else if (name === 'ins' || name === 'smarttag' || name === 'sdt' || name === 'sdtcontent') {
        out.push(...this.inlines(c)); // 변경 이력·컨트롤은 껍데기만 벗긴다
      }
    }
    return out;
  }

  /** 문단 -> 블록. 목록이면 항목 정보를 함께 돌려준다 */
  paragraph(el: Element): { block?: DocBlock; item?: DocListItem } {
    const props = firstChild(el, 'ppr');
    const styleId = attrValue(firstChild(props ?? el, 'pstyle'));
    const style = styleId ? this.styles.get(styleId) : undefined;
    const inlines = this.inlines(el);

    // 목록 여부: w:numPr
    const numPr = props ? firstChild(props, 'numpr') : undefined;
    if (numPr) {
      const numId = attrValue(firstChild(numPr, 'numid'));
      const level = Number(attrValue(firstChild(numPr, 'ilvl')) ?? '0');
      return {
        item: {
          level: Number.isFinite(level) ? level : 0,
          ordered: numId ? (this.numbering.get(numId) ?? false) : false,
          children: inlines,
        },
      };
    }

    if (inlines.length === 0) return {};

    // 수식만 있는 문단은 블록 수식($$)으로. Word는 이런 문단을 m:oMathPara로 적는다
    const meaningful = inlines.filter((c) => !(c.kind === 'text' && c.text.trim().length === 0));
    if (meaningful.length === 1 && meaningful[0].kind === 'math') {
      const math = meaningful[0];
      return { block: { kind: 'mathblock', math: math.math, tex: math.tex } };
    }

    // 제목
    const outline = attrValue(firstChild(props ?? el, 'outlinelvl'));
    const level = style?.heading ?? (outline !== undefined ? Number(outline) + 1 : undefined);
    if (level !== undefined && level >= 1 && level <= 6) {
      return { block: { kind: 'heading', level, children: inlines } };
    }

    // 이미지 하나뿐인 문단은 블록 이미지로
    if (inlines.length === 1 && inlines[0].kind === 'image') {
      const image = inlines[0];
      return { block: { kind: 'imageblock', src: image.src, alt: image.alt, width: image.width, height: image.height } };
    }

    // 인용문: 왼쪽 테두리가 있는 문단
    const quote = props !== undefined && firstChild(props, 'pbdr') !== undefined;
    return { block: { kind: 'paragraph', children: inlines, quote: quote || undefined } };
  }

  /** 표 -> DocTable. 코드 블록으로 쓰인 1칸 표는 코드로 되돌린다 */
  table(el: Element): DocBlock | null {
    const rows: DocTableCell[][] = [];
    for (const tr of kids(el)) {
      if (localName(tr) !== 'tr') continue;
      const cells: DocTableCell[] = [];
      for (const tc of kids(tr)) {
        if (localName(tc) !== 'tc') continue;
        const paragraphs = kids(tc).filter((c) => localName(c) === 'p');
        const children: DocInline[] = [];
        paragraphs.forEach((p, index) => {
          if (index > 0) children.push({ kind: 'break' });
          children.push(...this.inlines(p));
        });
        const tcPr = firstChild(tc, 'tcpr');
        const shading = attrValue(firstChild(tcPr ?? tc, 'shd'), 'fill');
        cells.push({
          children,
          header: shading !== undefined && shading !== 'auto' && shading !== 'FFFFFF' ? true : undefined,
        });
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return null;

    // 내보내기에서 코드 블록을 1칸 표로 감쌌으므로 되돌린다
    if (rows.length === 1 && rows[0].length === 1) {
      const lines = codeLines(rows[0][0].children);
      if (lines) return { kind: 'code', lines };
    }
    return { kind: 'table', rows };
  }
}

/** 1칸 표의 내용이 코드처럼 보이면 코드 줄로 (모든 조각이 고정폭이어야 한다) */
function codeLines(children: readonly DocInline[]): { runs: DocText[] }[] | null {
  const texts = children.filter((c) => c.kind === 'text') as DocText[];
  if (texts.length === 0 || !texts.every((t) => t.code)) return null;
  const lines: { runs: DocText[] }[] = [{ runs: [] }];
  for (const c of children) {
    if (c.kind === 'break') { lines.push({ runs: [] }); continue; }
    if (c.kind !== 'text') continue;
    const parts = c.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push({ runs: [] });
      if (part.length > 0) lines[lines.length - 1].runs.push({ kind: 'text', text: part });
    });
  }
  return lines;
}

/**
 * DOCX 부품들 -> DocModel.
 * document.xml을 읽지 못하면 예외를 던진다 (호출한 쪽이 사용자에게 알린다).
 */
export function docxToDocModel(parts: DocxParts, title: string): DocModel {
  const doc = parseXml(parts.document);
  if (!doc) throw new Error('문서 XML을 읽지 못했습니다. 손상된 파일일 수 있습니다.');
  const body = Array.from(doc.getElementsByTagName('*')).find((el) => localName(el) === 'body');
  if (!body) throw new Error('문서 본문을 찾지 못했습니다.');

  const reader = new DocxReader(
    readStyles(parts.styles),
    readRels(parts.rels),
    readNumbering(parts.numbering),
    parts.media ?? {},
  );

  const blocks: DocBlock[] = [];
  let listItems: DocListItem[] = [];
  const flushList = (): void => {
    if (listItems.length > 0) blocks.push({ kind: 'list', items: listItems });
    listItems = [];
  };

  for (const el of kids(body)) {
    const name = localName(el);
    if (name === 'p') {
      const { block, item } = reader.paragraph(el);
      if (item) { listItems.push(item); continue; }
      flushList();
      if (block) blocks.push(block);
    } else if (name === 'tbl') {
      flushList();
      const table = reader.table(el);
      if (table) blocks.push(table);
    }
  }
  flushList();

  return { title, blocks };
}
