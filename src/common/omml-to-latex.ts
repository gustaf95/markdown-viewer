// ---------------------------------------------------------------------------
// OMML(Office Math) -> LaTeX (F-1205)
//  - DOCX 가져오기에서 <m:oMath>를 Markdown의 $...$ 로 되돌린다.
//  - src/main/omml.ts가 MathML -> OMML로 보낸 길을 거꾸로 따라간다.
//  - renderer에서 DOMParser로 파싱한 Element를 받는다 (main에는 XML 파서가 없다).
//  - 네임스페이스 접두사는 문서마다 다를 수 있어 localName만 본다.
// ---------------------------------------------------------------------------

/** 유니코드 기호 -> LaTeX 명령. 없는 것은 그대로 둔다 (KaTeX가 유니코드도 받는다) */
const SYMBOLS: Record<string, string> = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ϵ': '\\epsilon', 'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta',
  'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda',
  'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'ϕ': '\\phi', 'φ': '\\varphi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋃': '\\bigcup', '⋂': '\\bigcap',
  '−': '-', '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '⋅': '\\cdot',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '∼': '\\sim', '≅': '\\cong', '∝': '\\propto',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '√': '\\sqrt',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊃': '\\supset',
  '⊆': '\\subseteq', '⊇': '\\supseteq', '∩': '\\cap', '∪': '\\cup',
  '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '¬': '\\neg',
  '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '⋯': '\\cdots', '…': '\\ldots', '⋮': '\\vdots', '⋱': '\\ddots',
  '∠': '\\angle', '∴': '\\therefore', '∵': '\\because',
  '°': '^\\circ', '′': "'", '″': "''",
};

/** 강조 기호 -> LaTeX 명령 */
const ACCENTS: Record<string, string> = {
  '̂': '\\hat', 'ˆ': '\\hat', '^': '\\hat',
  '̃': '\\tilde', '˜': '\\tilde', '~': '\\tilde',
  '̇': '\\dot', '˙': '\\dot',
  '̈': '\\ddot', '¨': '\\ddot',
  '⃗': '\\vec', '→': '\\vec',
  '̌': '\\check', 'ˇ': '\\check',
  '̆': '\\breve', '˘': '\\breve',
  '́': '\\acute', '´': '\\acute',
  '̀': '\\grave', '`': '\\grave',
  '̄': '\\bar', '¯': '\\bar', '‾': '\\overline',
};

/** LaTeX에서 뜻이 있는 문자 — 본문 글자로 쓰려면 escape 해야 한다 */
const LATEX_ESCAPE: Record<string, string> = {
  '\\': '\\backslash ', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
  '#': '\\#', '%': '\\%', '_': '\\_',
};

function localName(el: Element): string {
  return el.localName.toLowerCase();
}

function children(el: Element): Element[] {
  return Array.from(el.children);
}

/** 이름이 맞는 첫 자식 */
function child(el: Element, name: string): Element | undefined {
  return children(el).find((c) => localName(c) === name);
}

/** m:e, m:num 같은 컨테이너 여러 개 */
function childrenNamed(el: Element, name: string): Element[] {
  return children(el).filter((c) => localName(c) === name);
}

/** m:xxxPr 안의 m:chr 등에서 m:val 속성 읽기 */
function propValue(parent: Element | undefined, name: string): string | undefined {
  if (!parent) return undefined;
  const el = child(parent, name);
  if (!el) return undefined;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().endsWith('val')) return attr.value;
  }
  return undefined;
}

/** 여러 토큰을 이어붙일 때, LaTeX 명령 뒤에 글자가 붙지 않도록 공백을 넣는다 */
function join(parts: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (out && /\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(part)) out += ' ';
    out += part;
  }
  return out;
}

/** 인자 하나를 중괄호로 (한 글자면 그대로 두어 `x^2`처럼 짧게) */
function braced(latex: string): string {
  const s = latex.trim();
  if (s.length === 0) return '{}';
  if (s.length === 1 && !/[\\{}]/.test(s)) return s;
  return `{${s}}`;
}

/** m:t 안의 글자 — 기호는 LaTeX 명령으로, 특수문자는 escape */
function convertText(text: string, normalText: boolean): string {
  if (normalText) {
    // m:nor (본문 글꼴) — \text{}로 감싸 한글이 수식 글꼴로 깨지지 않게 한다
    return text.length > 0 ? `\\text{${text.replace(/([\\{}$&#%_])/g, '\\$1')}}` : '';
  }
  let out = '';
  for (const ch of text) {
    const symbol = SYMBOLS[ch];
    if (symbol) out = join([out, symbol]);
    else if (LATEX_ESCAPE[ch]) out += LATEX_ESCAPE[ch];
    else out += ch;
  }
  return out;
}

/** 자식들을 차례로 변환해 이어붙인다 */
function convertRow(el: Element): string {
  return join(children(el).map(convertNode));
}

function convertNode(el: Element): string {
  const name = localName(el);
  const kids = children(el);

  switch (name) {
    case 'omath':
    case 'omathpara':
    case 'e':
    case 'num':
    case 'den':
    case 'lim':
    case 'deg':
      return convertRow(el);

    case 'r': {
      // 글자 조각. m:rPr/m:nor 이면 본문 글꼴이다
      const normal = child(el, 'rpr') !== undefined && child(child(el, 'rpr')!, 'nor') !== undefined;
      const text = childrenNamed(el, 't').map((t) => t.textContent ?? '').join('');
      return convertText(text, normal);
    }
    case 't':
      return convertText(el.textContent ?? '', false);

    case 'f': {
      // 분수. m:fPr/m:type=noBar 면 이항계수
      const type = propValue(child(el, 'fpr'), 'type');
      const num = convertRow(child(el, 'num') ?? el);
      const den = convertRow(child(el, 'den') ?? el);
      if (type === 'nobar') return `\\binom{${num}}{${den}}`;
      return `\\frac{${num}}{${den}}`;
    }

    case 'rad': {
      // 근호. m:degHide=1 이면 차수 없는 제곱근
      const hidden = propValue(child(el, 'radpr'), 'deghide');
      const degree = convertRow(child(el, 'deg') ?? el).trim();
      const body = convertRow(child(el, 'e') ?? el);
      if (hidden === '1' || hidden === 'on' || degree.length === 0) return `\\sqrt{${body}}`;
      return `\\sqrt[${degree}]{${body}}`;
    }

    case 'ssup':
      return `${braced(convertRow(child(el, 'e') ?? el))}^${braced(convertRow(child(el, 'sup') ?? el))}`;
    case 'ssub':
      return `${braced(convertRow(child(el, 'e') ?? el))}_${braced(convertRow(child(el, 'sub') ?? el))}`;
    case 'ssubsup':
      return (
        `${braced(convertRow(child(el, 'e') ?? el))}` +
        `_${braced(convertRow(child(el, 'sub') ?? el))}` +
        `^${braced(convertRow(child(el, 'sup') ?? el))}`
      );

    case 'nary': {
      // 큰 연산자. m:chr이 없으면 적분이 기본값이다
      const props = child(el, 'narypr');
      const chr = propValue(props, 'chr') ?? '∫';
      const operator = SYMBOLS[chr] ?? chr;
      const subHidden = propValue(props, 'subhide') === '1';
      const supHidden = propValue(props, 'suphide') === '1';
      const sub = subHidden ? '' : convertRow(child(el, 'sub') ?? el).trim();
      const sup = supHidden ? '' : convertRow(child(el, 'sup') ?? el).trim();
      const body = convertRow(child(el, 'e') ?? el);
      let out = operator;
      if (sub) out += `_${braced(sub)}`;
      if (sup) out += `^${braced(sup)}`;
      return join([out, body]);
    }

    case 'd': {
      // 늘어나는 괄호. 구분자가 비어 있으면 `.` (한쪽만 있는 괄호)
      const props = child(el, 'dpr');
      const open = propValue(props, 'begchr') ?? '(';
      const close = propValue(props, 'endchr') ?? ')';
      const inner = childrenNamed(el, 'e').map(convertRow).join(' , ');
      return `\\left${fence(open)} ${inner} \\right${fence(close)}`;
    }

    case 'limlow': {
      const base = convertRow(child(el, 'e') ?? el);
      const lim = convertRow(child(el, 'lim') ?? el);
      // \lim_{...} 처럼 자연스러운 것은 첨자로, 그 밖에는 \underset
      return /\\(lim|max|min|sup|inf|liminf|limsup)$/.test(base.trim())
        ? `${base}_${braced(lim)}`
        : `\\underset{${lim}}{${base}}`;
    }
    case 'limupp': {
      const base = convertRow(child(el, 'e') ?? el);
      const lim = convertRow(child(el, 'lim') ?? el);
      return `\\overset{${lim}}{${base}}`;
    }

    case 'acc': {
      const chr = propValue(child(el, 'accpr'), 'chr') ?? '̂';
      const command = ACCENTS[chr] ?? '\\hat';
      return `${command}{${convertRow(child(el, 'e') ?? el)}}`;
    }
    case 'bar': {
      const pos = propValue(child(el, 'barpr'), 'pos');
      const body = convertRow(child(el, 'e') ?? el);
      return pos === 'bot' ? `\\underline{${body}}` : `\\overline{${body}}`;
    }
    case 'groupchr': {
      const chr = propValue(child(el, 'groupchrpr'), 'chr') ?? '';
      const body = convertRow(child(el, 'e') ?? el);
      if (chr === '⏞') return `\\overbrace{${body}}`;
      if (chr === '⏟') return `\\underbrace{${body}}`;
      return body;
    }

    case 'm': {
      // 행렬. 열 구분은 &, 행 구분은 \\
      const rows = childrenNamed(el, 'mr').map((row) => childrenNamed(row, 'e').map(convertRow).join(' & '));
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }

    case 'func': {
      const fname = convertRow(child(el, 'fname') ?? el);
      return join([fname, convertRow(child(el, 'e') ?? el)]);
    }

    case 'box':
    case 'borderbox':
      return convertRow(child(el, 'e') ?? el);

    case 'rpr':
    case 'ctrlpr':
    case 'fpr':
    case 'radpr':
    case 'narypr':
    case 'dpr':
    case 'accpr':
    case 'barpr':
    case 'mpr':
    case 'omathparapr':
    case 'groupchrpr':
    case 'limlowpr':
    case 'limupppr':
      return ''; // 속성 묶음은 값만 쓰고 본문에는 넣지 않는다

    default:
      return kids.length > 0 ? convertRow(el) : convertText(el.textContent ?? '', false);
  }
}

/** \left / \right 뒤의 구분자 표기 */
function fence(chr: string): string {
  if (chr === '' || chr === ' ') return '.';
  if (chr === '{' || chr === '}') return `\\${chr}`;
  if (chr === '|') return '|';
  if (chr === '‖') return '\\|';
  if (chr === '⟨') return '\\langle';
  if (chr === '⟩') return '\\rangle';
  if (chr === '⌈') return '\\lceil';
  if (chr === '⌉') return '\\rceil';
  if (chr === '⌊') return '\\lfloor';
  if (chr === '⌋') return '\\rfloor';
  return chr;
}

/**
 * `<m:oMath>` 또는 `<m:oMathPara>` 요소를 LaTeX 문자열로.
 * 변환 결과가 비면 null (호출한 쪽이 그 수식을 건너뛴다).
 */
export function ommlToLatex(el: Element): string | null {
  const latex = convertNode(el).replace(/\s+/g, ' ').trim();
  return latex.length > 0 ? latex : null;
}
