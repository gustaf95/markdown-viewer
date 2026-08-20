import type { MathNode } from '../common/docmodel';

// ---------------------------------------------------------------------------
// MathML -> 한글 수식 스크립트 (F-1103)
//  - KaTeX가 만든 MathML을 한글의 네이티브 수식 개체 스크립트로 바꾼다.
//    HWPX에서는 이 문자열이 <hp:equation><hp:script>에 그대로 들어가고,
//    한글이 열 때 직접 조판하므로 이미지와 달리 확대해도 깨지지 않고 편집도 된다.
//  - 문법은 한글 2020으로 실제 조판해 보며 확인했다. 확인된 사실 몇 가지:
//      * 유니코드 기호(α ∑ ∫ ≤ × → ...)는 그대로 써도 인식된다. 이름표를 따로 두지 않는다.
//      * `pm`/`mp`는 인식되지 않는다. ±는 유니코드나 `+-`를 써야 한다.
//      * `#`는 어디서나 줄바꿈이므로 본문 문자로 쓰려면 반드시 escape 한다.
//      * `^`와 `_`는 backslash로 escape 되지 않는다. 따옴표 문자열로 감싸야 한다.
//      * 따옴표 문자열("...")은 공백과 한글을 그대로 유지하며 정자체로 나온다.
// ---------------------------------------------------------------------------

/** 화면에 보이지 않는 제어 문자 (함수 적용, 보이지 않는 곱 등) */
const INVISIBLE_RE = /[⁡⁢⁣⁤​]/g;

/** 여는/닫는 괄호 (fence 속성이 없을 때의 보조 판별용) */
const OPEN_FENCES = new Set(['(', '[', '{', '⟨', '⌈', '⌊', '|', '‖']);
const CLOSE_FENCES = new Set([')', ']', '}', '⟩', '⌉', '⌋', '|', '‖']);

/** 위에 붙는 강조 기호 -> 한글 수식 명령 */
const ACCENTS: Record<string, string> = {
  '^': 'hat', 'ˆ': 'hat', '̂': 'hat',
  '~': 'tilde', '˜': 'tilde', '̃': 'tilde',
  '˙': 'dot', '̇': 'dot',
  '¨': 'ddot', '̈': 'ddot',
  '→': 'vec', '⃗': 'vec',
  'ˇ': 'check', '̌': 'check',
  '˘': 'breve', '̆': 'breve',
  '´': 'acute', '́': 'acute',
  '`': 'grave', '̀': 'grave',
};

/** 위/아래 선 (\overline, \underline) */
const BAR_CHARS = new Set(['¯', '‾', '̄', '_', '̲', '―', '__']);

/**
 * 큰 연산자는 유니코드 기호를 그대로 쓰면 한계값이 옆에 붙어 버린다.
 * 이름표로 바꿔야 한글이 기호 위아래에 놓는다 (∑, ∏ 등).
 */
const BIG_OPERATORS: Record<string, string> = {
  '∑': 'sum',
  '∏': 'prod',
  '∐': 'coprod',
  '⋃': 'union',
  '⋂': 'inter',
  '∫': 'int',
  '∬': 'dint',
  '∭': 'tint',
  '∮': 'oint',
  '∯': 'odint',
  '∰': 'otint',
};

/** 한글이 정자체 + 앞뒤 여백까지 챙겨 주는 함수 이름들 */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot',
  'sinh', 'cosh', 'tanh', 'coth',
  'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf',
  'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'hom', 'mod',
]);

// 스크립트에서 특별한 뜻을 가진 문자.
//  - `{ } & # \` 는 backslash escape가 통한다.
//  - `^ _ ~ ` "` 는 escape가 통하지 않아 따옴표 문자열로 빼낸다.
const BACKSLASH_ESCAPE = /[{}&#\\]/;
const QUOTE_ONLY = /[\^_~`"]/;

/** 기호/변수 한 덩어리를 스크립트 문자로 (특수문자는 escape) */
function escapeAtom(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '"') out += '″'; // 따옴표는 문자열 안에 넣을 수 없어 비슷한 모양으로
    else if (QUOTE_ONLY.test(ch)) out += `"${ch}"`;
    else if (BACKSLASH_ESCAPE.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** 공백과 특수문자를 그대로 살려야 하는 글(\text{...}) — 따옴표 문자열로 */
function quoted(text: string): string {
  const body = text.replace(/\\/g, '\\\\').replace(/"/g, '″');
  return body.length === 0 ? '' : `"${body}"`;
}

/** 바깥 중괄호 한 쌍이 문자열 전체를 감싸는지 */
function isWrapped(s: string): boolean {
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/** 여러 토큰으로 된 식은 중괄호로 묶어야 over/^/_ 가 통째로 걸린다 */
function group(script: string): string {
  const s = script.trim();
  if (s.length === 0) return '{}';
  // 이미 한 덩어리면 그대로 (lim, sin 같은 함수 이름이 중괄호에 갇히지 않게)
  if (!/\s/.test(s) && !/[{}]/.test(s)) return s;
  if (isWrapped(s)) return s;
  return `{${s}}`;
}

function textOf(node: MathNode | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text.replace(INVISIBLE_RE, '');
  return (node.children ?? []).map(textOf).join('');
}

function attr(node: MathNode | undefined, name: string): string | undefined {
  return node?.attrs?.[name];
}

function isFence(node: MathNode | undefined, closing: boolean): boolean {
  if (!node || node.tag !== 'mo') return false;
  if (attr(node, 'fence') === 'true') return true;
  const text = textOf(node).trim();
  const set = closing ? CLOSE_FENCES : OPEN_FENCES;
  return set.has(text) && attr(node, 'stretchy') === 'true';
}

/** 여러 자식을 이어붙인다 (늘어나는 괄호 처리 포함) */
function convertRow(nodes: readonly MathNode[]): string {
  const children = nodes.filter(
    (n) => n.tag !== 'annotation' && n.tag !== 'annotation-xml' && n.tag !== 'mphantom',
  );
  if (children.length === 0) return '';

  const opens = isFence(children[0], false);
  const closes = children.length >= 2 && isFence(children[children.length - 1], true);
  // \left( ... \right) : 내용 높이에 맞춰 늘어나는 괄호.
  // \left\{ ... \right. 처럼 한쪽이 없으면 `.`으로 보이지 않는 짝을 만든다 (cases 환경)
  if (opens || closes) {
    // left/right 뒤의 구분자는 escape하지 않는다. `left \{`처럼 쓰면 괄호가 아니라 역슬래시가 그려진다
    const delim = (node: MathNode | undefined): string => textOf(node).trim() || '.';
    const begChr = opens ? delim(children[0]) : '.';
    const endChr = closes ? delim(children[children.length - 1]) : '.';
    const inner = children.slice(opens ? 1 : 0, closes ? -1 : undefined);
    return `left ${begChr} ${convertRow(inner)} right ${endChr}`;
  }

  return children.map(convertNode).filter((s) => s.length > 0).join(' ');
}

function convertNode(node: MathNode | undefined): string {
  if (!node) return '';
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
      return '';

    case 'mi': {
      const text = textOf(node).trim();
      if (text.length === 0) return '';
      if (text.length === 1) return escapeAtom(text);
      // sin/log 처럼 알려진 함수는 그대로 두면 한글이 정자체로 조판한다
      if (FUNCTIONS.has(text)) return text;
      return attr(node, 'mathvariant') === 'normal' ? quoted(text) : escapeAtom(text);
    }

    case 'mn':
    case 'mo':
    case 'ms': {
      const text = textOf(node).trim();
      return BIG_OPERATORS[text] ?? escapeAtom(text);
    }

    case 'mtext': {
      // \text{...} — 공백과 한글을 그대로 살린다
      const text = textOf(node);
      return text.trim().length === 0 ? '~' : quoted(text);
    }

    case 'mspace':
      return '~';

    case 'mfrac': {
      // 선 없는 분수 = 이항계수 — 한글에서는 atop
      const noBar = /^0(px|em)?$/.test(attr(node, 'linethickness') ?? '');
      return `${group(convertNode(kids[0]))} ${noBar ? 'atop' : 'over'} ${group(convertNode(kids[1]))}`;
    }

    case 'msqrt':
      return `sqrt ${group(convertRow(kids))}`;

    case 'mroot':
      return `root ${group(convertNode(kids[1]))} of ${group(convertNode(kids[0]))}`;

    case 'msup':
      return `${group(convertNode(kids[0]))} ^${group(convertNode(kids[1]))}`;
    case 'msub':
      return `${group(convertNode(kids[0]))} _${group(convertNode(kids[1]))}`;
    case 'msubsup':
      return `${group(convertNode(kids[0]))} _${group(convertNode(kids[1]))} ^${group(convertNode(kids[2]))}`;

    case 'mover': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return `overline ${group(convertNode(kids[0]))}`;
      const accent = ACCENTS[chr];
      if (accent) return `${accent} ${group(convertNode(kids[0]))}`;
      return `${group(convertNode(kids[0]))} ^${group(convertNode(kids[1]))}`;
    }
    case 'munder': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return `underline ${group(convertNode(kids[0]))}`;
      return `${group(convertNode(kids[0]))} _${group(convertNode(kids[1]))}`;
    }
    case 'munderover':
      return `${group(convertNode(kids[0]))} _${group(convertNode(kids[1]))} ^${group(convertNode(kids[2]))}`;

    case 'mtable':
      return matrix(node);
    case 'mtr':
    case 'mlabeledtr':
      return convertRow(kids);

    default:
      return convertRow(kids);
  }
}

/** mtable -> matrix{...} — 행렬·cases·align 환경이 모두 여기로 온다 */
function matrix(table: MathNode): string {
  const rows = (table.children ?? []).filter((r) => r.tag === 'mtr' || r.tag === 'mlabeledtr');
  const body = rows
    .map((row) => (row.children ?? []).map((cell) => convertNode(cell).trim() || '{}').join(' & '))
    .join(' # ');
  return `matrix{${body}}`;
}

/**
 * MathML 트리 -> 한글 수식 스크립트.
 * 변환 결과가 비면 null을 돌려주고, 호출한 쪽이 원본 LaTeX을 대신 넣는다.
 */
export function mathToHwpScript(math: MathNode): string | null {
  const script = convertNode(math).replace(/\s+/g, ' ').trim();
  return script.length > 0 ? script : null;
}
