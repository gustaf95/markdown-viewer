import type { DocBlock, DocInline, DocModel, DocTableCell, DocText } from './docmodel';

// ---------------------------------------------------------------------------
// DocModel -> Markdown (F-1201)
//  - 가져오기의 마지막 단계. HWPX·DOCX·HTML이 모두 여기로 모인다.
//  - 내보내기가 DocModel에서 여러 형식으로 갈라진 것과 대칭이다.
// ---------------------------------------------------------------------------

/** Markdown 문법으로 읽힐 수 있는 글자를 본문 글자로 되돌린다 */
function escapeText(text: string): string {
  return text
    .replace(/([\\`*_{}[\]<>])/g, '\\$1')
    // 줄 맨 앞에서만 뜻을 갖는 것들
    .replace(/^(\s*)([#>+-])/gm, '$1\\$2')
    .replace(/^(\s*\d+)\./gm, '$1\\.');
}

/** 표 칸 안에서는 `|`가 칸을 나누므로 따로 막는다 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function inlineText(run: DocText): string {
  if (run.text.length === 0) return '';
  // 인라인 코드 안은 escape하지 않는다. 대신 내용에 백틱이 있으면 울타리를 늘린다
  if (run.code) {
    const longest = (run.text.match(/`+/g) ?? []).reduce((max, s) => Math.max(max, s.length), 0);
    const fence = '`'.repeat(longest + 1);
    const pad = run.text.startsWith('`') || run.text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${run.text}${pad}${fence}`;
  }
  let out = escapeText(run.text);
  // 앞뒤 공백이 강조 안으로 들어가면 Markdown이 강조로 보지 않는다
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(out) ?? ['', '', out, ''];
  if (core.length === 0) return out;
  let marked = core;
  if (run.strike) marked = `~~${marked}~~`;
  if (run.bold && run.italic) marked = `***${marked}***`;
  else if (run.bold) marked = `**${marked}**`;
  else if (run.italic) marked = `*${marked}*`;
  out = lead + marked + trail;
  return out;
}

/** 수식을 인라인으로 (`$...$`). 내용에 `$`가 있으면 그대로 두면 깨지므로 막는다 */
function inlineMath(tex: string): string {
  const body = tex.trim().replace(/\$/g, '\\$');
  return body.length > 0 ? `$${body}$` : '';
}

function inlines(items: readonly DocInline[], inTable = false): string {
  let out = '';
  for (const item of items) {
    switch (item.kind) {
      case 'text':
        out += inTable ? escapeCell(inlineText(item)) : inlineText(item);
        break;
      case 'break':
        // 표 안에서는 줄바꿈을 넣을 수 없어 <br>로 (GFM이 허용한다)
        out += inTable ? '<br>' : '  \n';
        break;
      case 'link': {
        const label = inlines(item.children, inTable) || item.href;
        out += item.href ? `[${label}](${item.href})` : label;
        break;
      }
      case 'math':
        out += item.tex ? inlineMath(item.tex) : '';
        break;
      case 'image':
        out += `![${item.alt.replace(/[[\]]/g, '')}](${item.src})`;
        break;
      default:
        break;
    }
  }
  return out;
}

/** 표 한 줄 */
function tableRow(cells: readonly DocTableCell[], columns: number): string {
  const values: string[] = [];
  for (let i = 0; i < columns; i += 1) {
    const cell = cells[i];
    values.push(cell ? inlines(cell.children, true).replace(/\n/g, ' ').trim() : '');
  }
  return `| ${values.join(' | ')} |`;
}

function tableToMarkdown(rows: readonly DocTableCell[][]): string {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return '';
  // GFM 표는 머리행이 있어야 한다. 없으면 빈 머리행을 만들어 준다
  const hasHeader = rows[0].some((cell) => cell.header);
  const header = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;
  const align = (cell: DocTableCell | undefined): string =>
    cell?.align === 'center' ? ':---:' : cell?.align === 'right' ? '---:' : '---';

  const lines = [
    hasHeader ? tableRow(header, columns) : `|${' |'.repeat(columns)}`,
    `| ${Array.from({ length: columns }, (_, i) => align((hasHeader ? header : rows[0])[i])).join(' | ')} |`,
    ...body.map((row) => tableRow(row, columns)),
  ];
  return lines.join('\n');
}

/** 코드 블록의 울타리 — 내용에 백틱 줄이 있으면 길이를 늘린다 */
function codeFence(body: string): string {
  const longest = (body.match(/^`{3,}/gm) ?? []).reduce((max, s) => Math.max(max, s.length), 2);
  return '`'.repeat(Math.max(3, longest + 1));
}

function blockToMarkdown(block: DocBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(block.level, 1), 6))} ${inlines(block.children).trim()}`;

    case 'paragraph': {
      const text = inlines(block.children).trim();
      if (text.length === 0) return '';
      return block.quote ? text.split('\n').map((line) => `> ${line}`).join('\n') : text;
    }

    case 'list': {
      const counters: number[] = [];
      return block.items
        .map((item) => {
          const level = Math.max(0, item.level);
          counters.length = Math.max(counters.length, level + 1);
          counters[level] = (counters[level] ?? 0) + 1;
          for (let i = level + 1; i < counters.length; i += 1) counters[i] = 0;
          const indent = '  '.repeat(level);
          const marker =
            item.checked !== undefined
              ? `- [${item.checked ? 'x' : ' '}]`
              : item.ordered
                ? `${counters[level]}.`
                : '-';
          return `${indent}${marker} ${inlines(item.children).trim()}`;
        })
        .join('\n');
    }

    case 'code': {
      const body = block.lines.map((line) => line.runs.map((run) => run.text).join('')).join('\n');
      const fence = codeFence(body);
      // 언어 이름은 남아 있지 않다 (구문 강조 색만 있고 언어 정보는 없다)
      return `${fence}${block.language ?? ''}\n${body}\n${fence}`;
    }

    case 'table':
      return tableToMarkdown(block.rows);

    case 'mathblock':
      return block.tex ? `$$\n${block.tex.trim()}\n$$` : '';

    case 'imageblock':
      return `![${block.alt.replace(/[[\]]/g, '')}](${block.src})`;

    case 'rule':
      return '---';

    default:
      return '';
  }
}

/** DocModel -> Markdown 문자열 */
export function docModelToMarkdown(model: DocModel): string {
  const parts: string[] = [];
  for (const block of model.blocks) {
    const text = blockToMarkdown(block);
    if (text.length > 0) parts.push(text);
  }
  // 블록 사이는 빈 줄 하나로 띄운다
  return `${parts.join('\n\n')}\n`;
}
