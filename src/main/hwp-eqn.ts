import type { MathNode } from '../common/docmodel';

// ---------------------------------------------------------------------------
// MathML -> 한글 수식 스크립트 (F-1103)
//  - KaTeX가 만든 MathML을 한글의 네이티브 수식 개체 스크립트로 바꾼다.
//    HWPX에서는 이 문자열이 <hp:equation><hp:script>에 그대로 들어가고,
//    한글이 열 때 직접 조판하므로 이미지와 달리 확대해도 깨지지 않고 편집도 된다.
//  - **범위는 언제나 중괄호로 명시한다.** 한글 수식은 공백만으로 묶이는 범위가 모호해서,
//    `a over b c`처럼 두면 사람도 한글도 어디까지가 분모인지 알 수 없다.
//    첨자 인자, 분자/분모, 큰 연산자의 피연산자를 모두 `{...}`로 감싼다.
//        int_{0}^{T_{s}} {phi_{1}(t) phi_{2}(t)~dt} =0
//  - 문법은 한글 2020으로 실제 조판해 보며 확인했다. 확인된 사실 몇 가지:
//      * 유니코드 기호(≤ × → ∂ 등)도 인식되지만, 이름이 있는 것은 이름을 쓴다.
//        편집기에서 열었을 때 알아보기 쉽고, 글꼴이 없는 환경에서도 안전하다.
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
 * 큰 연산자. 유니코드 기호를 그대로 두면 한계값이 기호 옆에 붙어 버리고,
 * 이름표로 써야 한글이 위아래(∑) 또는 오른쪽 위아래(∫)에 제대로 놓는다.
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

/**
 * ASCII로 바꿔야 하는 유니코드 연산자.
 * KaTeX는 빼기를 U+2212(−)로 내보내는데, 한글 수식 편집기는 이 글자를 연산자가 아니라
 * 일반 기호로 다뤄 앞뒤 여백이 어긋난다. ASCII 하이픈이 제대로 된 빼기 연산자다.
 * 이름표와 달리 앞뒤에 공백을 넣지 않는다 (`a-b`).
 */
const ASCII_OPERATORS: Record<string, string> = {
  '−': '-', // U+2212 빼기표
  '∗': '*', // U+2217 별표 연산자
  '∕': '/', // U+2215 나눗셈 사선
};

/**
 * 유니코드 기호 -> 한글 수식 이름표.
 * 여기 없는 기호는 유니코드 그대로 내보낸다 (그래도 조판된다).
 * 이름을 잘못 적으면 그 글자들이 변수로 찍혀 버리므로, 실제로 조판해 확인한 것만 넣는다.
 */
const SYMBOL_NAMES: Record<string, string> = {
  ...BIG_OPERATORS,
  // 그리스 소문자 (KaTeX가 내보내는 코드포인트 기준)
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta',
  'ϵ': 'epsilon', 'ε': 'varepsilon', 'ζ': 'zeta', 'η': 'eta',
  'θ': 'theta', 'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda',
  'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi',
  'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon',
  'ϕ': 'phi', 'φ': 'varphi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  // 그리스 대문자
  'Γ': 'GAMMA', 'Δ': 'DELTA', 'Θ': 'THETA', 'Λ': 'LAMBDA',
  'Ξ': 'XI', 'Π': 'PI', 'Σ': 'SIGMA', 'Υ': 'UPSILON',
  'Φ': 'PHI', 'Ψ': 'PSI', 'Ω': 'OMEGA',
  // 연산자·관계
  '×': 'times', '÷': 'div', '∞': 'infinity', '∂': 'partial', '∇': 'nabla',
  '≤': 'leq', '≥': 'geq', '≠': 'neq', '≈': 'approx', '≡': 'equiv',
  '∈': 'in', '∉': 'notin', '⊂': 'subset', '⊃': 'supset',
  '∩': 'cap', '∪': 'cup',
  // 양방향 화살표는 이름표가 한글에서 한쪽 화살표로 잘못 조판돼 유니코드 그대로 둔다
  '→': 'rightarrow', '←': 'leftarrow', '⇒': 'Rightarrow', '⇐': 'Leftarrow',
  '↦': 'mapsto',
  '⋯': 'cdots', '…': 'ldots', '⋮': 'vdots', '⋱': 'ddots', '∠': 'angle',
  '±': '+-', '∓': '-+',
};

/** 큰 연산자의 피연산자를 어디까지 묶을지 — 관계 기호를 만나면 끊는다 */
const RELATIONS = new Set([
  '=', '≠', '≤', '≥', '<', '>', '≈', '≡', '∼', '≅',
  '→', '⇒', '↔', '⇔', '∈', '∉', '⊂', '⊃', '⊆', '⊇', ':=',
]);

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

/** 기호/변수 한 덩어리를 스크립트 문자로 (이름표 치환 + 특수문자 escape) */
function atom(text: string): string {
  const named = ASCII_OPERATORS[text] ?? SYMBOL_NAMES[text];
  if (named) return named;
  let out = '';
  for (const ch of text) {
    const ascii = ASCII_OPERATORS[ch];
    const name = SYMBOL_NAMES[ch];
    if (ascii) out += ascii;
    else if (name) out += ` ${name} `;
    else if (ch === '"') out += '″'; // 따옴표는 문자열 안에 넣을 수 없어 비슷한 모양으로
    else if (QUOTE_ONLY.test(ch)) out += `"${ch}"`;
    else if (BACKSLASH_ESCAPE.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
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

/** 범위를 확실히 하려고 언제나 중괄호로 감싼다 (첨자 인자, 분자/분모 등) */
function braced(script: string): string {
  const s = script.trim();
  if (s.length === 0) return '{}';
  return isWrapped(s) ? s : `{${s}}`;
}

/** 첨자가 붙는 밑동. 한 덩어리면 그대로 둔다 (`lim`, `sin`이 중괄호에 갇히지 않게) */
function base(script: string): string {
  const s = script.trim();
  if (s.length === 0) return '{}';
  if (!/\s/.test(s) && !/[{}]/.test(s)) return s;
  return braced(s);
}

/**
 * 토큰을 이어붙인다.
 * 여러 글자 이름(sin, alpha, over ...)은 앞뒤를 띄워야 다른 글자와 붙어 버리지 않는다.
 * 한 글자 변수·숫자끼리는 붙여도 뜻이 같으므로 붙인다 (`d t` -> `dt`, `2 a` -> `2a`).
 */
function joinAtoms(parts: readonly string[]): string {
  const tokens = parts.filter((s) => s.length > 0);
  let out = '';
  for (const token of tokens) {
    if (out.length > 0 && needsSpace(out, token)) out += ' ';
    out += token;
  }
  return out;
}

function needsSpace(prev: string, next: string): boolean {
  // 여러 글자로 된 이름은 옆 글자와 붙으면 다른 낱말이 되어 버린다
  if (/[A-Za-z]{2,}$/.test(prev) || /^[A-Za-z]{2,}/.test(next)) return true;
  return false;
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

/** 이 노드가 "큰 연산자 + 한계값" 형태면 그 연산자 이름을 돌려준다 */
function naryName(node: MathNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.tag === 'mo') return BIG_OPERATORS[textOf(node).trim()];
  switch (node.tag) {
    case 'munderover':
    case 'munder':
    case 'mover':
    case 'msubsup':
    case 'msub':
    case 'msup':
      return BIG_OPERATORS[textOf(node.children?.[0]).trim()];
    default:
      return undefined;
  }
}

function isRelation(node: MathNode | undefined): boolean {
  return node?.tag === 'mo' && RELATIONS.has(textOf(node).trim());
}

/** 여러 자식을 이어붙인다 (늘어나는 괄호와 큰 연산자 처리 포함) */
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

  const parts: string[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (naryName(node)) {
      // 큰 연산자: 뒤따르는 식을 관계 기호 직전까지 모아 중괄호로 묶는다.
      // 묶지 않으면 어디까지가 적분 대상인지 한글도 사람도 알 수 없다.
      let end = i + 1;
      while (end < children.length && !isRelation(children[end])) end += 1;
      const operand = convertRow(children.slice(i + 1, end));
      parts.push(operand.length > 0 ? `${convertNode(node)} ${braced(operand)}` : convertNode(node));
      i = end - 1;
      continue;
    }
    parts.push(convertNode(node));
  }
  return joinAtoms(parts);
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
      if (FUNCTIONS.has(text)) return text; // sin/log는 그대로 두면 한글이 정자체로 조판한다
      if (text.length === 1 || SYMBOL_NAMES[text]) return atom(text);
      return attr(node, 'mathvariant') === 'normal' ? quoted(text) : atom(text);
    }

    case 'mn':
    case 'mo':
    case 'ms':
      return atom(textOf(node).trim());

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
      return `${braced(convertNode(kids[0]))} ${noBar ? 'atop' : 'over'} ${braced(convertNode(kids[1]))}`;
    }

    case 'msqrt':
      return `sqrt ${braced(convertRow(kids))}`;

    case 'mroot':
      return `root ${braced(convertNode(kids[1]))} of ${braced(convertNode(kids[0]))}`;

    // 첨자는 밑동에 바로 붙이고 인자는 반드시 중괄호로 — `x_{1}`, `int_{0}^{T_{s}}`
    case 'msup':
      return `${base(convertNode(kids[0]))}^${braced(convertNode(kids[1]))}`;
    case 'msub':
      return `${base(convertNode(kids[0]))}_${braced(convertNode(kids[1]))}`;
    case 'msubsup':
      return `${base(convertNode(kids[0]))}_${braced(convertNode(kids[1]))}^${braced(convertNode(kids[2]))}`;

    case 'mover': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return `overline ${braced(convertNode(kids[0]))}`;
      const accent = ACCENTS[chr];
      if (accent) return `${accent} ${braced(convertNode(kids[0]))}`;
      return `${base(convertNode(kids[0]))}^${braced(convertNode(kids[1]))}`;
    }
    case 'munder': {
      const chr = textOf(kids[1]).trim();
      if (BAR_CHARS.has(chr)) return `underline ${braced(convertNode(kids[0]))}`;
      return `${base(convertNode(kids[0]))}_${braced(convertNode(kids[1]))}`;
    }
    case 'munderover':
      return `${base(convertNode(kids[0]))}_${braced(convertNode(kids[1]))}^${braced(convertNode(kids[2]))}`;

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

// ---------------------------------------------------------------------------
// 수식 상자 크기 어림
//  - <hp:equation>은 상자의 폭·높이와 기준선 위치(baseLine, 높이에 대한 %)를 갖는다.
//    한글은 파일을 열 때 이 값을 **다시 계산하지 않고** 그대로 쓴다 (수식을 편집해야 갱신된다).
//    그래서 값이 어긋나면 인라인 수식이 글줄 위로 떠 보인다.
//  - 조판을 흉내 낼 수는 없으니 MathML 구조에서 글자 크기(em) 단위로 어림한다.
//    상수는 한글이 실제로 조판한 수식 12개의 값과 맞춰 보정했다.
// ---------------------------------------------------------------------------

/** 글자 크기(em) 기준 상자 치수 */
export interface EqMetrics {
  /** 기준선 위 높이 */
  ascent: number;
  /** 기준선 아래 깊이 */
  descent: number;
  width: number;
}

/** 평범한 글자 한 줄의 높이 — 한글 실측(975/1050, baseLine 86)에서 얻었다 */
const GLYPH_ASCENT = 0.8;
const GLYPH_DESCENT = 0.13;
/** 첨자는 0.71배로 줄어 위/아래로 밀린다 */
const SCRIPT_SCALE = 0.714; // 실측
const SUP_SHIFT = 0.42;
const SUB_SHIFT = 0.2;
/** 분수 가로줄이 놓이는 높이 (수학 축) */
const AXIS = 0.25;

const ZERO: EqMetrics = { ascent: 0, descent: 0, width: 0 };

function box(ascent: number, descent: number, width: number): EqMetrics {
  return { ascent, descent, width };
}

function total(m: EqMetrics): number {
  return m.ascent + m.descent;
}

/** 나란히 놓기: 폭은 더하고 높이는 큰 쪽을 따른다 */
function beside(items: readonly EqMetrics[]): EqMetrics {
  return items.reduce(
    (acc, m) => box(Math.max(acc.ascent, m.ascent), Math.max(acc.descent, m.descent), acc.width + m.width),
    ZERO,
  );
}

/**
 * 한글 수식 글꼴(HancomEQN)의 글자 폭 (em).
 * 한 줄에 같은 글자를 20개씩 넣어 한글에 조판시키고 폭을 나눠 실측했다.
 * 이 글꼴은 1/28em 격자를 쓴다 — 값들이 0.357(10/28), 0.5(14/28) 처럼 떨어진다.
 */
const GLYPH_WIDTHS: Record<string, number> = {
  // 라틴 소문자
  a: 0.5, b: 0.429, c: 0.429, d: 0.571, e: 0.429, f: 0.571, g: 0.5, h: 0.571,
  i: 0.357, j: 0.357, k: 0.5, l: 0.339, m: 0.786, n: 0.571, o: 0.429, p: 0.5,
  q: 0.5, r: 0.429, s: 0.429, t: 0.357, u: 0.571, v: 0.429, w: 0.786, x: 0.571,
  y: 0.5, z: 0.429,
  // 라틴 대문자
  A: 0.786, B: 0.714, C: 0.643, D: 0.786, E: 0.643, F: 0.643, G: 0.714, H: 0.786,
  I: 0.429, J: 0.5, K: 0.786, L: 0.643, M: 0.929, N: 0.786, O: 0.786, P: 0.643,
  Q: 0.786, R: 0.714, S: 0.571, T: 0.786, U: 0.786, V: 0.786, W: 1.0, X: 0.714,
  Y: 0.786, Z: 0.643,
  // 기호
  '=': 0.5, '+': 0.786, '-': 0.786, '−': 0.786, '/': 0.5,
  '(': 0.357, ')': 0.357, '[': 0.357, ']': 0.357, '|': 0.357,
  ',': 0.349, '.': 0.286, '!': 0.286, '<': 0.35, '>': 0.35,
  '±': 0.786, '∓': 0.786, '×': 0.786, '÷': 0.786,
  // 그리스 (이름표로 나가지만 폭은 글자 기준)
  α: 0.571, β: 0.571, γ: 0.571, δ: 0.5, ε: 0.429, ϵ: 0.429, ζ: 0.5, η: 0.571,
  θ: 0.5, ι: 0.357, κ: 0.571, λ: 0.5, μ: 0.571, ν: 0.5, ξ: 0.5, π: 0.571,
  ρ: 0.5, σ: 0.5, τ: 0.5, υ: 0.571, ϕ: 0.571, φ: 0.571, χ: 0.571, ψ: 0.571, ω: 0.571,
  Γ: 0.643, Δ: 0.714, Θ: 0.714, Λ: 0.714, Ξ: 0.643, Π: 0.786, Σ: 0.643,
  Υ: 0.786, Φ: 0.786, Ψ: 0.786, Ω: 0.714,
  // 한 칸을 통째로 쓰는 기호들
  '∞': 1.0, '≤': 1.0, '≥': 1.0, '≠': 1.0, '≈': 1.0, '≡': 1.0, '∇': 1.0,
  '∈': 1.0, '∉': 1.0, '⊂': 1.0, '⊃': 1.0, '∩': 1.0, '∪': 1.0,
  '→': 1.0, '←': 1.0, '⇒': 1.0, '⇐': 1.0, '↦': 1.0,
  '⋯': 1.0, '…': 1.0, '⋮': 0.5, '⋱': 1.0, '∠': 0.714, '∂': 0.5,
};

/** 관계 기호는 앞뒤에 넓은 여백이, 이항 연산자는 좁은 여백이 붙는다 (TeX 관례와 같다) */
const RELATION_SPACE = 0.56;
const BINARY_SPACE = 0.44;
const BINARY_OPS = new Set(['+', '-', '−', '±', '∓', '×', '÷', '⋅', '∗', '∘', '⊕', '⊗']);

/** 글자 한 덩어리의 폭 (em) */
function glyphWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += GLYPH_WIDTHS[ch] ?? (/[a-z]/.test(ch) ? 0.5 : /[A-Z]/.test(ch) ? 0.75 : /[0-9]/.test(ch) ? 0.5 : 0.55);
    if (RELATIONS.has(ch)) width += RELATION_SPACE;
    else if (BINARY_OPS.has(ch)) width += BINARY_SPACE;
  }
  return width;
}

/**
 * 적분 기호는 그 자체로 키가 크고 한계값이 옆에 붙는다.
 * ∑·∏는 글리프가 작은 대신 한계값이 위아래로 쌓여 커진다 — 둘을 다르게 잡아야 한다.
 */
const INTEGRAL_CHARS = new Set(['∫', '∬', '∭', '∮', '∯', '∰']);

/** 한계값이 기호 위아래로 쌓이는 연산자인가 (∑·∏ 계열. 적분은 옆에 붙는다) */
function stacksLimits(node: MathNode | undefined): boolean {
  const text = textOf(node).trim();
  return BIG_OPERATORS[text] !== undefined && !INTEGRAL_CHARS.has(text);
}

function measureRow(nodes: readonly MathNode[]): EqMetrics {
  const items = nodes.map(measure);
  const row = beside(items);
  // 맨 앞에 오는 +/- 는 단항이라 앞뒤 여백이 붙지 않는다 (`-b`는 뺄셈이 아니다)
  const first = nodes[0];
  if (first?.tag === 'mo' && BINARY_OPS.has(textOf(first).trim())) {
    return box(row.ascent, row.descent, row.width - BINARY_SPACE);
  }
  return row;
}

function measure(node: MathNode | undefined): EqMetrics {
  if (!node) return ZERO;
  const kids = node.children ?? [];

  switch (node.tag) {
    case 'annotation':
    case 'annotation-xml':
    case 'mphantom':
      return ZERO;

    case 'mi':
    case 'mn':
    case 'mo':
    case 'ms':
    case 'mtext': {
      const text = textOf(node).trim();
      // 공백뿐인 mtext는 스크립트에서 `~`(온전한 한 칸)로 나간다
      if (text.length === 0) return node.tag === 'mtext' ? box(0, 0, 0.5) : ZERO;
      // 큰 연산자는 글자보다 위아래로 크다
      if (INTEGRAL_CHARS.has(text)) return box(1.55, 0.85, 0.8);
      if (BIG_OPERATORS[text]) return box(1.0, 0.35, 0.95);
      return box(GLYPH_ASCENT, GLYPH_DESCENT, glyphWidth(text));
    }

    case 'mspace':
      return box(0, 0, 0.5); // `~`는 온전한 한 칸 (실측)

    case 'mfrac': {
      const num = measure(kids[0]);
      const den = measure(kids[1]);
      return box(
        AXIS + 0.12 + total(num),
        Math.max(GLYPH_DESCENT, total(den) + 0.12 - AXIS),
        Math.max(num.width, den.width) + 0.476, // 실측
      );
    }

    case 'msqrt': {
      const inner = measureRow(kids);
      return box(inner.ascent + 0.18, inner.descent, inner.width + 0.805); // 근호 여백 실측
    }
    case 'mroot': {
      const inner = measure(kids[0]);
      return box(inner.ascent + 0.25, inner.descent, inner.width + 0.9);
    }

    // ∑·∏는 MathML이 옆첨자(msub/msup)로 주더라도 한글은 기호 위아래에 쌓는다.
    // 우리가 내보내는 스크립트 기준으로 재야 하므로 여기서 갈라 준다.
    case 'msup': {
      const b = measure(kids[0]);
      const s = measure(kids[1]);
      if (stacksLimits(kids[0])) return box(b.ascent + SCRIPT_SCALE * total(s), b.descent, Math.max(b.width, SCRIPT_SCALE * s.width));
      return box(Math.max(b.ascent, SUP_SHIFT + SCRIPT_SCALE * s.ascent), b.descent, b.width + SCRIPT_SCALE * s.width);
    }
    case 'msub': {
      const b = measure(kids[0]);
      const s = measure(kids[1]);
      if (stacksLimits(kids[0])) return box(b.ascent, b.descent + SCRIPT_SCALE * total(s), Math.max(b.width, SCRIPT_SCALE * s.width));
      return box(b.ascent, Math.max(b.descent, SUB_SHIFT + SCRIPT_SCALE * s.descent), b.width + SCRIPT_SCALE * s.width);
    }
    case 'msubsup': {
      const b = measure(kids[0]);
      const sub = measure(kids[1]);
      const sup = measure(kids[2]);
      if (stacksLimits(kids[0])) {
        return box(
          b.ascent + SCRIPT_SCALE * total(sup),
          b.descent + SCRIPT_SCALE * total(sub),
          Math.max(b.width, SCRIPT_SCALE * Math.max(sub.width, sup.width)),
        );
      }
      return box(
        Math.max(b.ascent, SUP_SHIFT + SCRIPT_SCALE * sup.ascent),
        Math.max(b.descent, SUB_SHIFT + SCRIPT_SCALE * sub.descent),
        b.width + SCRIPT_SCALE * Math.max(sub.width, sup.width),
      );
    }

    // 위/아래에 붙는 것들. 강조기호는 살짝만 커지고, 큰 연산자의 한계값은 위아래로 쌓인다
    case 'mover': {
      const b = measure(kids[0]);
      const o = measure(kids[1]);
      if (ACCENTS[textOf(kids[1]).trim()] || BAR_CHARS.has(textOf(kids[1]).trim())) {
        return box(b.ascent + 0.2, b.descent, b.width);
      }
      return box(b.ascent + SCRIPT_SCALE * total(o), b.descent, Math.max(b.width, SCRIPT_SCALE * o.width));
    }
    case 'munder': {
      const b = measure(kids[0]);
      const u = measure(kids[1]);
      if (BAR_CHARS.has(textOf(kids[1]).trim())) return box(b.ascent, b.descent + 0.15, b.width);
      return box(b.ascent, b.descent + SCRIPT_SCALE * total(u), Math.max(b.width, SCRIPT_SCALE * u.width));
    }
    case 'munderover': {
      const b = measure(kids[0]);
      const u = measure(kids[1]);
      const o = measure(kids[2]);
      return box(
        b.ascent + SCRIPT_SCALE * total(o),
        b.descent + SCRIPT_SCALE * total(u),
        Math.max(b.width, SCRIPT_SCALE * Math.max(u.width, o.width)),
      );
    }

    case 'mtable': {
      const rows = kids.filter((r) => r.tag === 'mtr' || r.tag === 'mlabeledtr').map((r) => measureRow(r.children ?? []));
      if (rows.length === 0) return ZERO;
      const height = rows.reduce((sum, r) => sum + total(r) + 0.15, 0);
      const width = rows.reduce((max, r) => Math.max(max, r.width), 0);
      // 행렬은 수학 축을 기준으로 위아래 반씩 놓인다
      return box(height / 2 + AXIS, Math.max(GLYPH_DESCENT, height / 2 - AXIS), width + 0.6);
    }

    default:
      return measureRow(kids);
  }
}

/**
 * 한글은 같은 수식에도 경로에 따라 다른 상자를 준다.
 * `EquationCreate`로 넣으면 딱 맞는 값을, 수식 편집기로 열었다 저장하면 조금 더 넉넉한 값을 쓴다.
 * 사용자가 편집기로 손보면 후자로 바뀌므로 그쪽에 맞춰 둔다 — 그래야 나중에 수식을 건드려도
 * 글줄 높이가 흔들리지 않는다. 계수는 편집기가 보정한 수식 12개와 비교해 얻었다.
 */
const EDITOR_HEIGHT_FACTOR = 1.07;
// 글자 폭은 실측표를 쓰지만 한글이 개체 좌우에 조금 더 여백을 둔다 (실측 결과 일정하게 5% 부족했다)
const EDITOR_WIDTH_FACTOR = 1.05;

/**
 * 수식 상자 치수를 글자 크기(em) 단위로 어림한다.
 * 늘어나는 괄호는 안쪽 높이를 따라가므로 폭만 조금 더한다.
 */
export function measureMath(math: MathNode): EqMetrics {
  const m = measure(math);
  if (total(m) === 0) return box(GLYPH_ASCENT, GLYPH_DESCENT, 1);
  // 위아래를 같은 비율로 늘리므로 기준선 위치(baseLine)는 그대로 유지된다
  return box(m.ascent * EDITOR_HEIGHT_FACTOR, m.descent * EDITOR_HEIGHT_FACTOR, m.width * EDITOR_WIDTH_FACTOR);
}
