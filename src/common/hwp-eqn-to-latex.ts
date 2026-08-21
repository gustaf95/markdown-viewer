// ---------------------------------------------------------------------------
// 한글 수식 스크립트 -> LaTeX (F-1205)
//  - HWPX 가져오기에서 <hp:script>를 Markdown의 $...$ 로 되돌린다.
//  - src/main/hwp-eqn.ts가 간 길을 거꾸로 따라간다. 문법은 그때 한글 2020으로
//    실제 조판해 보며 확인한 것을 그대로 쓴다.
//  - 우리가 내보낸 문서뿐 아니라 사람이 손으로 쓴 수식도 읽어야 하므로,
//    중괄호가 생략된 형태(`1 over 2`)도 받아들인다.
//
//  결합 규칙 (실측으로 확인):
//    `over`·`^`·`_`는 **바로 앞뒤의 한 덩어리**에만 걸린다.
//    `partial f over partial x`가 ∂(f/∂)x로 조판되는 것이 그 증거다.
//    그래서 앞은 이미 읽은 마지막 덩어리, 뒤는 다음 덩어리 하나만 가져온다.
// ---------------------------------------------------------------------------

/** 이름표 -> LaTeX. 한글이 실제로 인식하는 이름만 넣는다 */
const SYMBOLS: Record<string, string> = {
  // 그리스 소문자
  alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta',
  epsilon: '\\epsilon', varepsilon: '\\varepsilon', zeta: '\\zeta', eta: '\\eta',
  theta: '\\theta', vartheta: '\\vartheta', iota: '\\iota', kappa: '\\kappa',
  lambda: '\\lambda', mu: '\\mu', nu: '\\nu', xi: '\\xi', omicron: 'o',
  pi: '\\pi', varpi: '\\varpi', rho: '\\rho', varrho: '\\varrho',
  sigma: '\\sigma', varsigma: '\\varsigma', tau: '\\tau', upsilon: '\\upsilon',
  phi: '\\phi', varphi: '\\varphi', chi: '\\chi', psi: '\\psi', omega: '\\omega',
  // 그리스 대문자 — 한글은 대문자 이름을 대문자로 적는다
  GAMMA: '\\Gamma', DELTA: '\\Delta', THETA: '\\Theta', LAMBDA: '\\Lambda',
  XI: '\\Xi', PI: '\\Pi', SIGMA: '\\Sigma', UPSILON: '\\Upsilon',
  PHI: '\\Phi', PSI: '\\Psi', OMEGA: '\\Omega',
  // 큰 연산자
  sum: '\\sum', prod: '\\prod', coprod: '\\coprod',
  int: '\\int', dint: '\\iint', tint: '\\iiint',
  oint: '\\oint', odint: '\\oiint', otint: '\\oiiint',
  union: '\\bigcup', inter: '\\bigcap',
  // 관계·연산
  leq: '\\leq', geq: '\\geq', neq: '\\neq', approx: '\\approx', equiv: '\\equiv',
  sim: '\\sim', simeq: '\\simeq', cong: '\\cong', propto: '\\propto',
  ll: '\\ll', gg: '\\gg', doteq: '\\doteq',
  times: '\\times', div: '\\div', cdot: '\\cdot', ast: '\\ast', star: '\\star',
  circ: '\\circ', bullet: '\\bullet', oplus: '\\oplus', otimes: '\\otimes',
  plusminus: '\\pm', minusplus: '\\mp',
  // 집합·논리
  in: '\\in', notin: '\\notin', owns: '\\ni',
  subset: '\\subset', supset: '\\supset', subseteq: '\\subseteq', supseteq: '\\supseteq',
  cap: '\\cap', cup: '\\cup', emptyset: '\\emptyset',
  forall: '\\forall', exist: '\\exists', exists: '\\exists', lnot: '\\neg',
  vee: '\\vee', wedge: '\\wedge', therefore: '\\therefore', because: '\\because',
  // 화살표
  rightarrow: '\\rightarrow', leftarrow: '\\leftarrow',
  rarrow: '\\rightarrow', larrow: '\\leftarrow',
  Rightarrow: '\\Rightarrow', Leftarrow: '\\Leftarrow',
  RARROW: '\\Rightarrow', LARROW: '\\Leftarrow',
  lrarrow: '\\leftrightarrow', LRARROW: '\\Leftrightarrow',
  uparrow: '\\uparrow', downarrow: '\\downarrow', mapsto: '\\mapsto',
  // 기타 기호
  infinity: '\\infty', inf: '\\infty', INF: '\\infty',
  partial: '\\partial', nabla: '\\nabla', angle: '\\angle',
  cdots: '\\cdots', ldots: '\\ldots', vdots: '\\vdots', ddots: '\\ddots',
  prime: "'", degree: '^\\circ', bot: '\\bot', top: '\\top',
  aleph: '\\aleph', hbar: '\\hbar', imath: '\\imath', jmath: '\\jmath',
};

/** 한글이 정자체로 조판하는 함수 이름 -> LaTeX 명령 */
const FUNCTIONS: Record<string, string> = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan', sec: '\\sec', csc: '\\csc', cot: '\\cot',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', coth: '\\coth',
  arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan',
  log: '\\log', ln: '\\ln', lg: '\\lg', exp: '\\exp',
  lim: '\\lim', Lim: '\\lim', max: '\\max', min: '\\min', sup: '\\sup',
  det: '\\det', dim: '\\dim', ker: '\\ker', deg: '\\deg', gcd: '\\gcd',
  arg: '\\arg', hom: '\\hom', mod: '\\bmod', Pr: '\\Pr',
};

/** 앞의 한 덩어리에 씌우는 강조 명령 */
const ACCENTS: Record<string, string> = {
  hat: '\\hat', widehat: '\\widehat', check: '\\check', tilde: '\\tilde',
  widetilde: '\\widetilde', acute: '\\acute', grave: '\\grave',
  dot: '\\dot', ddot: '\\ddot', breve: '\\breve',
  bar: '\\bar', vec: '\\vec', dyad: '\\overleftrightarrow',
  overline: '\\overline', underline: '\\underline', under: '\\underline',
  OVERBRACE: '\\overbrace', UNDERBRACE: '\\underbrace',
};

/** 행렬 계열 -> LaTeX 환경 */
const MATRIX_ENVS: Record<string, string> = {
  matrix: 'matrix', pmatrix: 'pmatrix', bmatrix: 'bmatrix', dmatrix: 'vmatrix',
};

/** `left`/`right` 뒤의 구분자 */
function fence(chr: string): string {
  switch (chr) {
    case '': case '.': return '.';
    case '{': return '\\{';
    case '}': return '\\}';
    case '|': return '|';
    case '‖': return '\\|';
    case '⟨': case '<': return '\\langle';
    case '⟩': case '>': return '\\rangle';
    case '⌈': return '\\lceil';
    case '⌉': return '\\rceil';
    case '⌊': return '\\lfloor';
    case '⌋': return '\\rfloor';
    default: return chr;
  }
}

// ---------------------------------------------------------------------------
// 토큰 나누기
// ---------------------------------------------------------------------------
interface Token {
  kind: 'name' | 'group-open' | 'group-close' | 'sup' | 'sub' | 'amp' | 'hash' | 'text' | 'other';
  value: string;
}

const NAME_RE = /[A-Za-z]/;

/** 두 글자로 된 기호. 낱글자로 쪼개면 뜻이 달라진다 (`<=`는 ≤이지 `<`+`=`가 아니다) */
const TWO_CHAR_OPERATORS: Record<string, string> = {
  '+-': '\\pm', '-+': '\\mp',
  '<=': '\\leq', '>=': '\\geq', '!=': '\\neq', '==': '\\equiv',
  '->': '\\rightarrow', '<-': '\\leftarrow',
};

function tokenize(script: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < script.length) {
    const ch = script[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }

    // backslash escape — `\{` `\}` `\&` `\#` `\\`
    if (ch === '\\' && i + 1 < script.length) {
      out.push({ kind: 'other', value: script[i + 1] });
      i += 2;
      continue;
    }
    // 따옴표 문자열 — 공백과 한글을 그대로 담고 있다
    if (ch === '"') {
      let j = i + 1;
      let body = '';
      while (j < script.length && script[j] !== '"') { body += script[j]; j += 1; }
      out.push({ kind: 'text', value: body });
      i = j + 1;
      continue;
    }
    if (ch === '{') { out.push({ kind: 'group-open', value: ch }); i += 1; continue; }
    if (ch === '}') { out.push({ kind: 'group-close', value: ch }); i += 1; continue; }
    if (ch === '^') { out.push({ kind: 'sup', value: ch }); i += 1; continue; }
    if (ch === '_') { out.push({ kind: 'sub', value: ch }); i += 1; continue; }
    if (ch === '&') { out.push({ kind: 'amp', value: ch }); i += 1; continue; }
    if (ch === '#') { out.push({ kind: 'hash', value: ch }); i += 1; continue; }
    if (ch === '~') { out.push({ kind: 'other', value: '~' }); i += 1; continue; }
    if (ch === '`') { out.push({ kind: 'other', value: '`' }); i += 1; continue; }

    if (TWO_CHAR_OPERATORS[script.slice(i, i + 2)]) {
      out.push({ kind: 'other', value: script.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (NAME_RE.test(ch)) {
      let j = i;
      let name = '';
      while (j < script.length && NAME_RE.test(script[j])) { name += script[j]; j += 1; }
      out.push({ kind: 'name', value: name });
      i = j;
      continue;
    }

    // 숫자는 이어 붙여 하나로 (12.5 처럼)
    if (/[0-9]/.test(ch)) {
      let j = i;
      let num = '';
      while (j < script.length && /[0-9.]/.test(script[j])) { num += script[j]; j += 1; }
      out.push({ kind: 'other', value: num });
      i = j;
      continue;
    }

    out.push({ kind: 'other', value: ch });
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 파싱
// ---------------------------------------------------------------------------
/** LaTeX에서 뜻을 갖는 문자를 본문 글자로 */
function escapeLatex(text: string): string {
  return text.replace(/([\\{}$&#%_])/g, '\\$1');
}

/** 인자를 중괄호로 (한 글자면 그대로, 이미 싸여 있으면 그대로) */
function braced(latex: string): string {
  const s = latex.trim();
  if (s.length === 0) return '{}';
  if (s.length === 1 && !/[\\{}]/.test(s)) return s;
  if (/^\\[A-Za-z]+$/.test(s)) return s; // `\int` 같은 명령 하나는 감쌀 필요가 없다
  return stripBraces(s) === s ? `{${s}}` : s;
}

/** 명령 뒤에 글자가 바로 붙지 않도록 공백을 넣으며 잇는다 */
function join(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    // `\det A`가 `\detA`로 붙어 버리는 것만 막는다. 그 밖의 공백은 LaTeX이 무시한다
    if (out && /\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(part)) out += ' ';
    out += part;
  }
  return out.trim();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  /** 이름이 맞으면 소비 */
  private eatName(name: string): boolean {
    const token = this.peek();
    if (token?.kind === 'name' && token.value === name) { this.index += 1; return true; }
    return false;
  }

  /** 여러 덩어리를 읽어 이어붙인다. `stop`을 만나면 멈춘다 (소비하지 않음) */
  parseExpr(stop?: (t: Token) => boolean): string {
    const items: string[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'group-close') break;
      if (stop && stop(token)) break;

      // 첨자·분수는 앞뒤의 한 덩어리에만 걸린다
      if (token.kind === 'sup' || token.kind === 'sub') {
        this.index += 1;
        const base = items.pop() ?? '';
        const arg = this.parseItem();
        items.push(`${braced(base)}${token.kind === 'sup' ? '^' : '_'}${braced(arg)}`);
        continue;
      }
      if (token.kind === 'name' && (token.value === 'over' || token.value === 'atop')) {
        this.index += 1;
        const numerator = stripBraces(items.pop() ?? '');
        const denominator = stripBraces(this.parseItem());
        items.push(
          token.value === 'over'
            ? `\\frac{${numerator}}{${denominator}}`
            : `{${numerator} \\atop ${denominator}}`,
        );
        continue;
      }
      if (token.kind === 'name' && token.value === 'choose') {
        this.index += 1;
        const top = stripBraces(items.pop() ?? '');
        const bottom = stripBraces(this.parseItem());
        items.push(`\\binom{${top}}{${bottom}}`);
        continue;
      }

      items.push(this.parseItem());
    }
    return join(items);
  }

  /** 한 덩어리 */
  private parseItem(): string {
    const token = this.next();
    if (!token) return '';

    switch (token.kind) {
      case 'group-open': {
        const inner = this.parseExpr();
        if (this.peek()?.kind === 'group-close') this.index += 1;
        return `{${inner}}`;
      }
      case 'text':
        return `\\text{${escapeLatex(token.value)}}`;
      case 'sup':
      case 'sub': {
        // 밑동 없이 첨자가 먼저 온 경우 (드물다)
        const arg = this.parseItem();
        return `${token.kind === 'sup' ? '^' : '_'}${braced(arg)}`;
      }
      case 'amp':
        return '&';
      case 'hash':
        return '\\\\';
      case 'other':
        if (token.value === '~') return '\\ ';
        if (token.value === '`') return '\\,';
        return TWO_CHAR_OPERATORS[token.value] ?? escapeOther(token.value);
      case 'name':
        return this.parseName(token.value);
      default:
        return '';
    }
  }

  private parseName(name: string): string {
    if (name === 'sqrt') return `\\sqrt{${stripBraces(this.parseItem())}}`;

    if (name === 'root') {
      // root <차수> of <몸통>
      const degree = stripBraces(this.parseItem());
      this.eatName('of');
      const body = stripBraces(this.parseItem());
      return `\\sqrt[${degree}]{${body}}`;
    }

    if (name === 'left' || name === 'LEFT') {
      const open = this.readDelimiter();
      const inner = this.parseExpr((t) => t.kind === 'name' && (t.value === 'right' || t.value === 'RIGHT'));
      let close = '.';
      if (this.peek()?.kind === 'name') { this.index += 1; close = this.readDelimiter(); }
      return `\\left${fence(open)} ${inner} \\right${fence(close)}`;
    }

    const env = MATRIX_ENVS[name];
    if (env) return this.parseMatrix(env);
    if (name === 'cases') return this.parseCases();
    if (name === 'pile' || name === 'lpile' || name === 'rpile' || name === 'eqalign') {
      return `\\begin{matrix}${this.parseMatrixBody()}\\end{matrix}`;
    }

    const accent = ACCENTS[name];
    if (accent) return `${accent}{${stripBraces(this.parseItem())}}`;

    if (name === 'rm') return `\\mathrm{${stripBraces(this.parseItem())}}`;
    if (name === 'bold') return `\\mathbf{${stripBraces(this.parseItem())}}`;
    if (name === 'it') return `\\mathit{${stripBraces(this.parseItem())}}`;
    if (name === 'not') return `\\not${braced(this.parseItem())}`;

    const symbol = SYMBOLS[name];
    if (symbol) return symbol;
    const fn = FUNCTIONS[name];
    if (fn) return fn;

    // 알아보지 못한 이름은 변수로 둔다. `mc`는 변수 m과 c가 붙은 것이지 낱말이 아니다.
    // 정자체가 필요했다면 원본이 rm{...}으로 적었을 것이다.
    return name;
  }

  /** left/right 뒤의 구분자 한 글자 */
  private readDelimiter(): string {
    const token = this.peek();
    if (!token) return '.';
    this.index += 1;
    if (token.kind === 'group-open') return '{';
    if (token.kind === 'group-close') return '}';
    return token.value;
  }

  private parseMatrix(env: string): string {
    return `\\begin{${env}}${this.parseMatrixBody()}\\end{${env}}`;
  }

  /** cases는 왼쪽 중괄호가 붙은 두 칸짜리 표다 */
  private parseCases(): string {
    return `\\begin{cases}${this.parseMatrixBody()}\\end{cases}`;
  }

  /** `{a & b # c & d}` 의 안쪽을 LaTeX 표 본문으로 */
  private parseMatrixBody(): string {
    if (this.peek()?.kind !== 'group-open') return '';
    this.index += 1;
    const rows: string[][] = [[]];
    for (;;) {
      const token = this.peek();
      if (!token || token.kind === 'group-close') break;
      if (token.kind === 'amp') { this.index += 1; rows[rows.length - 1].push(''); continue; }
      if (token.kind === 'hash') { this.index += 1; rows.push([]); continue; }
      const cell = this.parseExpr((t) => t.kind === 'amp' || t.kind === 'hash');
      const row = rows[rows.length - 1];
      if (row.length === 0) row.push(cell);
      else row[row.length - 1] = join([row[row.length - 1], cell]);
    }
    if (this.peek()?.kind === 'group-close') this.index += 1;
    return rows.map((row) => row.join(' & ')).join(' \\\\ ');
  }
}

/** 중괄호로만 싸인 덩어리는 벗겨서 인자로 쓴다 */
function stripBraces(latex: string): string {
  const s = latex.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1) : s;
    }
  }
  return s;
}

/** 이름표가 아닌 낱글자 */
function escapeOther(value: string): string {
  if (value === '%' || value === '$') return `\\${value}`;
  return value;
}

/**
 * 한글 수식 스크립트 -> LaTeX.
 * 읽지 못하면 null (호출한 쪽이 원본 스크립트를 코드로 남긴다).
 */
export function hwpEquationToLatex(script: string): string | null {
  try {
    const latex = new Parser(tokenize(script)).parseExpr().replace(/\s+/g, ' ').trim();
    return latex.length > 0 ? latex : null;
  } catch {
    return null;
  }
}
