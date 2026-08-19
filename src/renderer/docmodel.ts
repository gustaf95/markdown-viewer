import type {
  DocBlock,
  DocCodeLine,
  DocInline,
  DocListItem,
  DocModel,
  DocTableCell,
  MathNode,
} from '../common/docmodel';

// ---------------------------------------------------------------------------
// 보기용 DOM -> DocModel (F-1102)
//  - DOCX/HWPX 내보내기의 공통 입력을 만든다.
//  - 브라우저 DOM을 그대로 읽으므로 main 쪽에 HTML/XML 파서가 필요 없다.
//  - 수식은 KaTeX가 만든 MathML(.katex-mathml > math)을 그대로 옮기고,
//    화면 표시용 .katex-html 은 건너뛴다 (같은 수식이 두 번 들어가지 않도록).
// ---------------------------------------------------------------------------

interface Marks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'table', 'blockquote', 'pre', 'hr', 'div', 'section']);

/** rgb(r, g, b) -> RRGGBB (docx는 # 없는 6자리 16진수를 쓴다) */
function rgbToHex(color: string): string | undefined {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  if (!m) return undefined;
  const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
  return (hex(m[1]) + hex(m[2]) + hex(m[3])).toUpperCase();
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** MathML DOM -> MathNode 트리 */
function toMathNode(el: Element): MathNode {
  const node: MathNode = { tag: el.localName.toLowerCase() };
  if (el.attributes.length > 0) {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
    node.attrs = attrs;
  }
  const children: MathNode[] = [];
  let text = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
    else if (isElement(child)) children.push(toMathNode(child));
  }
  if (text.length > 0) node.text = text;
  if (children.length > 0) node.children = children;
  return node;
}

/** .katex 요소에서 MathML과 원본 LaTeX을 뽑는다 */
function readKatex(el: Element): { math: MathNode; tex?: string } | null {
  const math = el.querySelector('math');
  if (!math) return null;
  const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? undefined;
  return { math: toMathNode(math), tex: tex?.trim() || undefined };
}

/** 인라인 노드 순회: 텍스트 서식/링크/수식/이미지를 DocInline으로 */
function walkInline(node: Node, marks: Marks, out: DocInline[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text.length > 0) out.push({ kind: 'text', text, ...marks });
    return;
  }
  if (!isElement(node)) return;

  const el = node;
  const tag = el.tagName.toLowerCase();

  // 수식: MathML만 취하고 화면용 .katex-html 은 버린다
  if (el.classList.contains('katex')) {
    const katex = readKatex(el);
    if (katex) out.push({ kind: 'math', math: katex.math, tex: katex.tex });
    return;
  }
  if (el.classList.contains('katex-html') || el.classList.contains('katex-mathml')) return;

  switch (tag) {
    case 'br':
      out.push({ kind: 'break' });
      return;
    case 'img': {
      const img = el as HTMLImageElement;
      out.push({
        kind: 'image',
        src: img.getAttribute('src') ?? '',
        alt: img.getAttribute('alt') ?? '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      });
      return;
    }
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const children: DocInline[] = [];
      for (const child of Array.from(el.childNodes)) walkInline(child, marks, children);
      if (children.length > 0) out.push({ kind: 'link', href, children });
      return;
    }
    case 'input': // 체크박스 목록의 input은 목록 항목 쪽에서 처리한다
      return;
    default:
      break;
  }

  const next: Marks = { ...marks };
  if (tag === 'strong' || tag === 'b') next.bold = true;
  if (tag === 'em' || tag === 'i') next.italic = true;
  if (tag === 'del' || tag === 's' || tag === 'strike') next.strike = true;
  if (tag === 'code') next.code = true;

  for (const child of Array.from(el.childNodes)) walkInline(child, next, out);
}

function isBlank(inline: DocInline): boolean {
  return inline.kind === 'text' && inline.text.trim().length === 0;
}

/** 블록 경계의 개행/들여쓰기 공백이 문단 앞뒤에 남지 않도록 정리 */
function trimInlines(inlines: DocInline[]): DocInline[] {
  const out = inlines.slice();
  while (out.length > 0 && isBlank(out[0])) out.shift();
  while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
  // 첫/마지막 조각의 바깥쪽 공백도 제거 (체크박스 목록의 "☑  항목" 같은 이중 공백 방지)
  const first = out[0];
  if (first?.kind === 'text') out[0] = { ...first, text: first.text.replace(/^[ \t\n]+/, '') };
  const last = out[out.length - 1];
  if (last?.kind === 'text') out[out.length - 1] = { ...last, text: last.text.replace(/[ \t\n]+$/, '') };
  return out;
}

function inlinesOf(el: Element, skip?: (child: Element) => boolean): DocInline[] {
  const out: DocInline[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (isElement(child) && skip?.(child)) continue;
    walkInline(child, {}, out);
  }
  return trimInlines(out);
}

/** 코드 블록: 구문 강조 색상을 계산된 스타일에서 읽어 줄 단위로 나눈다 */
function readCodeLines(code: Element): DocCodeLine[] {
  const lines: DocCodeLine[] = [{ runs: [] }];

  const push = (text: string, color?: string): void => {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push({ runs: [] });
      if (part.length > 0) lines[lines.length - 1].runs.push({ kind: 'text', text: part, color });
    });
  };

  const walk = (node: Node, color?: string): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.textContent ?? '', color);
      return;
    }
    if (!isElement(node)) return;
    // hljs 클래스별 색상표를 따로 두지 않고 CSS가 계산한 색을 그대로 쓴다
    const own = rgbToHex(window.getComputedStyle(node).color) ?? color;
    for (const child of Array.from(node.childNodes)) walk(child, own);
  };

  for (const child of Array.from(code.childNodes)) walk(child);
  while (lines.length > 1 && lines[lines.length - 1].runs.length === 0) lines.pop();
  return lines;
}

function languageOf(code: Element): string | undefined {
  const cls = Array.from(code.classList).find((c) => c.startsWith('language-'));
  return cls ? cls.slice('language-'.length) : undefined;
}

/** 표: tr을 훑고 th 여부와 정렬을 셀에 담는다 */
function convertTable(table: Element): DocBlock {
  const rows: DocTableCell[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells: DocTableCell[] = [];
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== 'th' && tag !== 'td') continue;
      const textAlign = (cell as HTMLElement).style.textAlign;
      cells.push({
        children: inlinesOf(cell),
        header: tag === 'th' || undefined,
        align: textAlign === 'center' || textAlign === 'right' ? textAlign : undefined,
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { kind: 'table', rows };
}

/** 목록: 중첩 목록을 level로 펼친다 (docx/HWPX 모두 수준 번호로 표현하기 쉽다) */
function collectListItems(list: Element, level: number, items: DocListItem[]): void {
  const ordered = list.tagName.toLowerCase() === 'ol';
  for (const li of Array.from(list.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    items.push({
      level,
      ordered,
      children: inlinesOf(li, (child) => {
        const tag = child.tagName.toLowerCase();
        return tag === 'ul' || tag === 'ol';
      }),
      checked: checkbox ? checkbox.checked : undefined,
    });
    for (const nested of Array.from(li.children)) {
      const tag = nested.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') collectListItems(nested, level + 1, items);
    }
  }
}

/** 블록 요소 하나를 DocBlock으로 변환해 out에 추가 */
function convertBlock(el: Element, out: DocBlock[], quote: boolean): void {
  const tag = el.tagName.toLowerCase();

  if (HEADING_TAGS.has(tag)) {
    out.push({ kind: 'heading', level: Number(tag.slice(1)), children: inlinesOf(el) });
    return;
  }

  // 디스플레이 수식 (markdown-it-texmath는 <section>으로 감싼다)
  const display = el.classList.contains('katex-display')
    ? el
    : el.querySelector(':scope > .katex-display');
  if (display) {
    const katex = readKatex(display);
    if (katex) {
      out.push({ kind: 'mathblock', math: katex.math, tex: katex.tex });
      return;
    }
  }

  switch (tag) {
    case 'p': {
      const inlines = inlinesOf(el);
      if (inlines.length === 0) return;
      // 이미지 하나만 있는 문단은 블록 이미지로 (가운데 정렬해서 넣는다)
      const only = inlines[0];
      if (inlines.length === 1 && only.kind === 'image') {
        out.push({ kind: 'imageblock', src: only.src, alt: only.alt, width: only.width, height: only.height });
        return;
      }
      out.push({ kind: 'paragraph', children: inlines, quote: quote || undefined });
      return;
    }
    case 'ul':
    case 'ol': {
      const items: DocListItem[] = [];
      collectListItems(el, 0, items);
      if (items.length > 0) out.push({ kind: 'list', items });
      return;
    }
    case 'blockquote':
      for (const child of Array.from(el.children)) convertBlock(child, out, true);
      return;
    case 'table':
      out.push(convertTable(el));
      return;
    case 'hr':
      out.push({ kind: 'rule' });
      return;
    case 'pre': {
      const code = el.querySelector('code');
      if (code) out.push({ kind: 'code', language: languageOf(code), lines: readCodeLines(code) });
      return;
    }
    default:
      break;
  }

  if (el.classList.contains('code-block')) {
    const code = el.querySelector('pre code');
    if (code) out.push({ kind: 'code', language: languageOf(code), lines: readCodeLines(code) });
    return;
  }

  // 그 밖의 컨테이너(div, section 등): 블록 자식이 있으면 재귀, 없으면 문단으로
  const hasBlockChild = Array.from(el.children).some(
    (child) => BLOCK_TAGS.has(child.tagName.toLowerCase()) || HEADING_TAGS.has(child.tagName.toLowerCase()),
  );
  if (hasBlockChild) {
    for (const child of Array.from(el.children)) convertBlock(child, out, quote);
    return;
  }
  const inlines = inlinesOf(el);
  if (inlines.length > 0) out.push({ kind: 'paragraph', children: inlines, quote: quote || undefined });
}

/**
 * 렌더링된 본문(#content)에서 DocModel을 만든다.
 * 코드 색상을 계산된 스타일에서 읽으므로 호출 전에 라이트 테마가 적용돼 있어야 한다.
 */
export function buildDocModel(root: HTMLElement, title: string): DocModel {
  const blocks: DocBlock[] = [];
  for (const child of Array.from(root.children)) convertBlock(child, blocks, false);
  return { title, blocks };
}
