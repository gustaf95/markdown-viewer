import { ImportedXmlComponent } from 'docx';
import type { MathNode } from '../common/docmodel';

// ---------------------------------------------------------------------------
// MathML -> OMML(Office Math) 변환 (F-1102)
//  - KaTeX가 만든 MathML을 Word의 네이티브 수식 개체로 바꾼다.
//    이미지로 붙이는 방식과 달리 글꼴 크기에 따라 재조판되고 Word에서 편집도 된다.
//  - docx 라이브러리의 ImportedXmlComponent(공개 API)로 임의의 XML 요소를 구성한다.
//  - 지원 범위는 KaTeX가 실제로 내보내는 요소들로 한정한다.
// ---------------------------------------------------------------------------

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** 적분/합/곱처럼 아래위(또는 아래첨자/윗첨자)에 범위를 붙이는 큰 연산자 */
const NARY_CHARS = new Set([
  '∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰',
  '⋀', '⋁', '⋂', '⋃', '⨀', '⨁', '⨂', '⨄', '⨆',
]);

/** 위에 붙는 강조 기호 (\hat, \tilde, \vec, \dot ...) */
const ACCENT_CHARS = new Set([
  '^', 'ˆ', '̂', '~', '˜', '̃', '˙', '̇', '¨', '̈',
  '˘', '̆', '˚', '̊', '´', '́', '`', '̀',
  '→', '⃗', '⃗', 'ˇ', '̌',
]);

/** 위/아래 선 (\overline, \underline) */
const BAR_CHARS = new Set(['¯', '‾', '̄', '_', '̲', '―']);

/** 여는/닫는 괄호 (fence 속성이 없을 때의 보조 판별용) */
const OPEN_FENCES = new Set(['(', '[', '{', '⟨', '⌈', '⌊', '|', '‖']);
const CLOSE_FENCES = new Set([')', ']', '}', '⟩', '⌉', '⌋', '|', '‖']);

/** 화면에 보이지 않는 제어 문자 (함수 적용, 보이지 않는 곱 등) */
const INVISIBLE_RE = /[⁡⁢⁣⁤​]/g;

type Comp = ImportedXmlComponent;

function el(name: string, attrs?: Record<string, string>, children?: readonly (Comp | string)[]): Comp {
  const component = new ImportedXmlComponent(name, attrs);
  for (const child of children ?? []) component.push(child);
  return component;
}

/** m:sty 값: p(정자체) / i(이탤릭) / b(굵게) / bi(굵은 이탤릭) */
type MathStyle = 'p' | 'i' | 'b' | 'bi';

/**
 * 수식 런 하나.
 * @param normalText true면 수식 글꼴이 아닌 본문 글꼴로 표시한다 (\text{한글} 대응)
 */
function mathRun(text: string, style?: MathStyle, normalText?: boolean): Comp {
  const props: Comp[] = [];
  if (normalText) props.push(el('m:nor'));
  else if (style) props.push(el('m:sty', { 'm:val': style }));
  const children: (Comp | string)[] = [];
  if (props.length > 0) children.push(el('m:rPr', undefined, props));
  children.push(el('m:t', { 'xml:space': 'preserve' }, [text]));
  return el('m:r', undefined, children);
}

function textOf(node: MathNode | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text.replace(INVISIBLE_RE, '');
  return (node.children ?? []).map(textOf).join('');
}

function attr(node: MathNode | undefined, name: string): string | undefined {
  return node?.attrs?.[name];
}

/** mathvariant 속성 -> OMML 스타일 */
function styleOf(node: MathNode, fallback: MathStyle): MathStyle {
  switch (attr(node, 'mathvariant')) {
    case 'normal':
      return 'p';
    case 'italic':
      return 'i';
    case 'bold':
      return 'b';
    case 'bold-italic':
      return 'bi';
    default:
      return fallback;
  }
}

function isNaryNode(node: MathNode | undefined): boolean {
  return node !== undefined && node.tag === 'mo' && NARY_CHARS.has(textOf(node).trim());
}

/** 이 노드가 "큰 연산자 + 범위" 형태인지 (뒤따르는 식을 피연산자로 삼아야 한다) */
function naryBase(node: MathNode): MathNode | undefined {
  const first = node.children?.[0];
  switch (node.tag) {
    case 'munderover':
    case 'munder':
    case 'mover':
    case 'msubsup':
    case 'msub':
    case 'msup':
      return isNaryNode(first) ? first : undefined;
    case 'mo':
      return isNaryNode(node) ? node : undefined;
    default:
      return undefined;
  }
}

function isFence(node: MathNode | undefined, closing: boolean): boolean {
  if (!node || node.tag !== 'mo') return false;
  const text = textOf(node).trim();
  if (attr(node, 'fence') === 'true') return true;
  return closing ? CLOSE_FENCES.has(text) && attr(node, 'stretchy') === 'true' : OPEN_FENCES.has(text) && attr(node, 'stretchy') === 'true';
}

/** 자식 목록을 OMML 요소 배열로 (괄호 묶음과 큰 연산자 처리 포함) */
function convertRow(nodes: readonly MathNode[]): Comp[] {
  const children = nodes.filter((n) => n.tag !== 'annotation' && n.tag !== 'annotation-xml');

  // \left( ... \right) : 내용 높이에 맞춰 늘어나는 괄호로
  if (children.length >= 2 && isFence(children[0], false) && isFence(children[children.length - 1], true)) {
    const begChr = textOf(children[0]).trim();
    const endChr = textOf(children[children.length - 1]).trim();
    return [
      el('m:d', undefined, [
        el('m:dPr', undefined, [el('m:begChr', { 'm:val': begChr }), el('m:endChr', { 'm:val': endChr })]),
        el('m:e', undefined, convertRow(children.slice(1, -1))),
      ]),
    ];
  }

  const out: Comp[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    const nary = naryBase(node);
    if (nary) {
      // 큰 연산자: 뒤에 오는 식 전체가 피연산자(m:e)가 된다
      out.push(buildNary(node, nary, convertRow(children.slice(i + 1))));
      return out;
    }
    out.push(...convertNode(node));
  }
  return out;
}

/** 큰 연산자(∑, ∫ ...) — 아래위 범위와 피연산자를 묶는다 */
function buildNary(node: MathNode, operator: MathNode, operand: Comp[]): Comp {
  const kids = node.children ?? [];
  let sub: MathNode | undefined;
  let sup: MathNode | undefined;
  switch (node.tag) {
    case 'munderover':
    case 'msubsup':
      sub = kids[1];
      sup = kids[2];
      break;
    case 'munder':
    case 'msub':
      sub = kids[1];
      break;
    case 'mover':
    case 'msup':
      sup = kids[1];
      break;
    default:
      break;
  }
  // ∑는 기호 위아래, ∫는 오른쪽 위아래에 범위를 두는 것이 관례
  const limLoc = node.tag.startsWith('mu') ? 'undOvr' : 'subSup';
  const props: Comp[] = [
    el('m:chr', { 'm:val': textOf(operator).trim() }),
    el('m:limLoc', { 'm:val': limLoc }),
  ];
  if (!sub) props.push(el('m:subHide', { 'm:val': '1' }));
  if (!sup) props.push(el('m:supHide', { 'm:val': '1' }));

  return el('m:nary', undefined, [
    el('m:naryPr', undefined, props),
    el('m:sub', undefined, sub ? convertNode(sub) : []),
    el('m:sup', undefined, sup ? convertNode(sup) : []),
    el('m:e', undefined, operand),
  ]);
}

/** 자식 하나를 m:e 같은 단일 컨테이너 내용으로 */
function convertNode(node: MathNode | undefined): Comp[] {
  if (!node) return [];
  const kids = node.children ?? [];

  switch (node.tag) {
    // 투명한 컨테이너: 자식만 이어붙인다
    case 'math':
    case 'semantics':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'menclose':
    case 'merror':
    case 'mtd':
      return convertRow(kids);

    case 'annotation':
    case 'annotation-xml':
    case 'mphantom':
      return [];

    case 'mi': {
      const text = textOf(node);
      if (text.length === 0) return [];
      // 한 글자 변수는 이탤릭(Word 기본), sin/log 같은 여러 글자 이름은 정자체
      const fallback: MathStyle = text.trim().length > 1 ? 'p' : 'i';
      return [mathRun(text, styleOf(node, fallback))];
    }
    case 'mn':
    case 'mo':
    case 'ms': {
      const text = textOf(node);
      return text.length === 0 ? [] : [mathRun(text, styleOf(node, 'p'))];
    }
    case 'mtext': {
      const text = textOf(node);
      // \text{...} 는 본문 글꼴로 (한글이 수식 글꼴에서 깨지지 않도록)
      return text.length === 0 ? [] : [mathRun(text, undefined, true)];
    }
    case 'mspace':
      return [mathRun(' ', 'p')];

    case 'mfrac': {
      const noBar = attr(node, 'linethickness') === '0' || attr(node, 'linethickness') === '0px';
      const props = noBar ? [el('m:fPr', undefined, [el('m:type', { 'm:val': 'noBar' })])] : [];
      return [
        el('m:f', undefined, [
          ...props,
          el('m:num', undefined, convertNode(kids[0])),
          el('m:den', undefined, convertNode(kids[1])),
        ]),
      ];
    }

    case 'msqrt':
      return [
        el('m:rad', undefined, [
          el('m:radPr', undefined, [el('m:degHide', { 'm:val': '1' })]),
          el('m:deg'),
          el('m:e', undefined, convertRow(kids)),
        ]),
      ];

    case 'mroot':
      return [
        el('m:rad', undefined, [
          el('m:deg', undefined, convertNode(kids[1])),
          el('m:e', undefined, convertNode(kids[0])),
        ]),
      ];

    case 'msup':
      return [
        el('m:sSup', undefined, [
          el('m:e', undefined, convertNode(kids[0])),
          el('m:sup', undefined, convertNode(kids[1])),
        ]),
      ];
    case 'msub':
      return [
        el('m:sSub', undefined, [
          el('m:e', undefined, convertNode(kids[0])),
          el('m:sub', undefined, convertNode(kids[1])),
        ]),
      ];
    case 'msubsup':
      return [
        el('m:sSubSup', undefined, [
          el('m:e', undefined, convertNode(kids[0])),
          el('m:sub', undefined, convertNode(kids[1])),
          el('m:sup', undefined, convertNode(kids[2])),
        ]),
      ];

    case 'mover': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return [bar(kids[0], 'top')];
      if (ACCENT_CHARS.has(chr)) return [accent(kids[0], chr)];
      return [
        el('m:limUpp', undefined, [
          el('m:e', undefined, convertNode(kids[0])),
          el('m:lim', undefined, convertNode(kids[1])),
        ]),
      ];
    }
    case 'munder': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return [bar(kids[0], 'bot')];
      return [
        el('m:limLow', undefined, [
          el('m:e', undefined, convertNode(kids[0])),
          el('m:lim', undefined, convertNode(kids[1])),
        ]),
      ];
    }
    case 'munderover':
      // 큰 연산자가 아닌 munderover: 아래 극한을 먼저, 그 위에 위 극한
      return [
        el('m:limUpp', undefined, [
          el('m:e', undefined, [
            el('m:limLow', undefined, [
              el('m:e', undefined, convertNode(kids[0])),
              el('m:lim', undefined, convertNode(kids[1])),
            ]),
          ]),
          el('m:lim', undefined, convertNode(kids[2])),
        ]),
      ];

    case 'mtable':
      return [matrix(node)];
    case 'mtr':
    case 'mlabeledtr':
      return convertRow(kids);

    default:
      return convertRow(kids);
  }
}

function accent(base: MathNode | undefined, chr: string): Comp {
  return el('m:acc', undefined, [
    el('m:accPr', undefined, [el('m:chr', { 'm:val': chr })]),
    el('m:e', undefined, convertNode(base)),
  ]);
}

function bar(base: MathNode | undefined, pos: 'top' | 'bot'): Comp {
  return el('m:bar', undefined, [
    el('m:barPr', undefined, [el('m:pos', { 'm:val': pos })]),
    el('m:e', undefined, convertNode(base)),
  ]);
}

/** mtable -> m:m (행렬). 행렬/케이스/정렬 환경이 모두 여기로 온다 */
function matrix(table: MathNode): Comp {
  const rows = (table.children ?? []).filter((r) => r.tag === 'mtr' || r.tag === 'mlabeledtr');
  const columns = rows.reduce((max, row) => Math.max(max, (row.children ?? []).length), 0);
  const rowComps = rows.map((row) =>
    el(
      'm:mr',
      undefined,
      (row.children ?? []).map((cell) => el('m:e', undefined, convertNode(cell))),
    ),
  );
  return el('m:m', undefined, [
    el('m:mPr', undefined, [
      el('m:mcs', undefined, [
        el('m:mc', undefined, [
          el('m:mcPr', undefined, [
            el('m:count', { 'm:val': String(Math.max(columns, 1)) }),
            el('m:mcJc', { 'm:val': 'center' }),
          ]),
        ]),
      ]),
    ]),
    ...rowComps,
  ]);
}

/**
 * MathML 트리를 OMML 요소로.
 * @param display true면 문단 가운데에 놓이는 디스플레이 수식(m:oMathPara)
 */
export function mathToOmml(math: MathNode, display: boolean): Comp {
  const body = convertNode(math);
  const oMath = el('m:oMath', display ? undefined : { 'xmlns:m': MATH_NS }, body);
  if (!display) return oMath;
  return el('m:oMathPara', { 'xmlns:m': MATH_NS }, [
    el('m:oMathParaPr', undefined, [el('m:jc', { 'm:val': 'center' })]),
    oMath,
  ]);
}
