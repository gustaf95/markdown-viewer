import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from 'docx';
import type {
  DocBlock,
  DocCodeLine,
  DocInline,
  DocListItem,
  DocModel,
  DocTableCell,
  DocText,
} from '../common/docmodel';
import { mathToOmml } from './omml';

// ---------------------------------------------------------------------------
// DOCX 내보내기 (F-1102)
//  - 입력은 renderer가 만든 DocModel (보기 화면과 같은 내용).
//  - 수식은 MathML -> OMML로 바꿔 Word 네이티브 수식 개체로 넣는다 (omml.ts).
//    이미지로 붙이지 않으므로 Word에서 확대/편집해도 깨지지 않는다.
//  - 한글 문서용으로 맑은 고딕 + 1.3 줄간격을 기본값으로 한다.
// ---------------------------------------------------------------------------

/** 본문 글꼴 (한글: 맑은 고딕, 라틴: Malgun Gothic) */
const BODY_FONT = { ascii: 'Malgun Gothic', hAnsi: 'Malgun Gothic', eastAsia: '맑은 고딕' } as const;
/** 코드 글꼴 — D2Coding이 없는 PC를 위해 라틴은 Consolas로 */
const MONO_FONT = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'D2Coding' } as const;

const BODY_SIZE = 21; // half-point = 10.5pt
const CODE_SIZE = 18; // 9pt
const PAGE_MARGIN_MM = 20;
/** 본문에 들어갈 수 있는 최대 이미지 폭(px, 96dpi 기준) — A4 폭에서 좌우 여백을 뺀 값 */
const MAX_IMAGE_WIDTH = Math.round(((210 - PAGE_MARGIN_MM * 2) / 25.4) * 96);

const TEXT_COLOR = '1F2328';
const MUTED_COLOR = '59636E';
const LINK_COLOR = '0969DA';
const BORDER_COLOR = 'D1D9E0';
const CODE_BG = 'F6F8FA';
const HEADER_BG = 'F3F4F6';

const BULLET_REF = 'mdv-bullet';
const NUMBER_REF = 'mdv-number';

const IMAGE_TYPES: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

/** docx의 ParagraphChild 타입에는 임의 XML 요소가 없어 OMML 삽입 시 캐스팅이 필요하다 */
function asChild(component: unknown): ParagraphChild {
  return component as ParagraphChild;
}

// ---------------------------------------------------------------------------
// 인라인
// ---------------------------------------------------------------------------
function textRun(run: DocText, mono = false): TextRun {
  return new TextRun({
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    strike: run.strike,
    font: mono || run.code ? MONO_FONT : BODY_FONT,
    size: mono ? CODE_SIZE : run.code ? BODY_SIZE - 2 : BODY_SIZE,
    color: run.color ?? (run.code ? 'C0392B' : undefined),
    shading: run.code ? { type: ShadingType.CLEAR, fill: CODE_BG } : undefined,
  });
}

function inlineChildren(inlines: readonly DocInline[]): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'text':
        out.push(textRun(inline));
        break;
      case 'break':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'link': {
        const runs = inline.children
          .filter((child): child is DocText => child.kind === 'text')
          .map((child) => new TextRun({
            text: child.text,
            bold: child.bold,
            italics: child.italic,
            font: BODY_FONT,
            size: BODY_SIZE,
            color: LINK_COLOR,
            underline: {},
          }));
        if (runs.length === 0) break;
        // 문서 밖으로 나가는 링크만 하이퍼링크로 (file:// 등은 글자만 남긴다)
        if (/^(https?|mailto):/i.test(inline.href)) {
          out.push(new ExternalHyperlink({ children: runs, link: inline.href }));
        } else {
          out.push(...runs);
        }
        break;
      }
      case 'math':
        out.push(...mathChildren(inline.math, inline.tex, false));
        break;
      case 'image': {
        const image = imageRun(inline.src, inline.width, inline.height);
        out.push(image ?? new TextRun({ text: `[이미지: ${inline.alt || inline.src}]`, italics: true, color: MUTED_COLOR }));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 수식 하나 -> OMML. 변환에 실패하면 원본 LaTeX을 고정폭으로 남긴다 */
function mathChildren(math: Parameters<typeof mathToOmml>[0], tex: string | undefined, display: boolean): ParagraphChild[] {
  try {
    return [asChild(mathToOmml(math, display))];
  } catch {
    const fallback = tex ?? '';
    return [new TextRun({ text: fallback, font: MONO_FONT, size: CODE_SIZE, color: MUTED_COLOR })];
  }
}

// ---------------------------------------------------------------------------
// 이미지
// ---------------------------------------------------------------------------
/** 로컬 파일/데이터 URI 이미지를 읽어 ImageRun으로. 실패하면 null */
function imageRun(src: string, naturalWidth: number, naturalHeight: number): ImageRun | null {
  let data: Buffer;
  let type: 'png' | 'jpg' | 'gif' | 'bmp' | undefined;
  try {
    if (/^data:/i.test(src)) {
      const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/i.exec(src);
      if (!match) return null;
      type = match[1].toLowerCase().startsWith('jp') ? 'jpg' : (match[1].toLowerCase() as 'png' | 'gif' | 'bmp');
      data = Buffer.from(match[2], 'base64');
    } else if (/^file:/i.test(src)) {
      const filePath = fileURLToPath(src);
      type = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
      if (!type) return null; // SVG 등 Word가 바로 받지 못하는 형식
      data = fs.readFileSync(filePath);
    } else {
      return null; // http(s) 이미지는 내려받지 않는다
    }
  } catch {
    return null;
  }

  const width = naturalWidth > 0 ? naturalWidth : MAX_IMAGE_WIDTH;
  const height = naturalHeight > 0 ? naturalHeight : Math.round(width * 0.75);
  const scale = width > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH / width : 1;
  return new ImageRun({
    type,
    data,
    transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
}

// ---------------------------------------------------------------------------
// 블록
// ---------------------------------------------------------------------------
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function listParagraph(item: DocListItem, instance: number): Paragraph {
  const children = inlineChildren(item.children);
  // 체크박스 목록은 글머리표 대신 ☑/☐ 기호로 (Word에서 원래 모양과 가장 비슷하다)
  if (item.checked !== undefined) {
    return new Paragraph({
      children: [new TextRun({ text: item.checked ? '☑ ' : '☐ ', font: BODY_FONT, size: BODY_SIZE }), ...children],
      indent: { left: convertMillimetersToTwip(6 + item.level * 6) },
      spacing: { after: 40 },
    });
  }
  return new Paragraph({
    children,
    numbering: { reference: item.ordered ? NUMBER_REF : BULLET_REF, level: Math.min(item.level, 4), instance },
    spacing: { after: 40 },
  });
}

/** 코드 블록: 배경색을 가진 1칸짜리 표로 감싸 Word에서도 블록으로 보이게 한다 */
function codeTable(lines: readonly DocCodeLine[]): Table {
  const paragraphs = lines.map(
    (line) =>
      new Paragraph({
        children:
          line.runs.length > 0
            ? line.runs.map((run) => textRun(run, true))
            : [new TextRun({ text: '', font: MONO_FONT, size: CODE_SIZE })],
        spacing: { line: 240, before: 0, after: 0 },
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders(BORDER_COLOR),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: paragraphs,
            shading: { type: ShadingType.CLEAR, fill: CODE_BG },
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
          }),
        ],
      }),
    ],
  });
}

function allBorders(color: string): Record<'top' | 'bottom' | 'left' | 'right' | 'insideHorizontal' | 'insideVertical', { style: (typeof BorderStyle)['SINGLE']; size: number; color: string }> {
  const side = { style: BorderStyle.SINGLE, size: 4, color };
  return {
    top: side,
    bottom: side,
    left: side,
    right: side,
    insideHorizontal: side,
    insideVertical: side,
  };
}

function cellParagraphs(cell: DocTableCell): Paragraph[] {
  const alignment =
    cell.align === 'center' ? AlignmentType.CENTER : cell.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const children = inlineChildren(
    cell.header ? cell.children.map((c) => (c.kind === 'text' ? { ...c, bold: true } : c)) : cell.children,
  );
  return [
    new Paragraph({
      children: children.length > 0 ? children : [new TextRun({ text: '' })],
      alignment,
      spacing: { before: 40, after: 40, line: 260 },
    }),
  ];
}

function docTable(rows: readonly DocTableCell[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders(BORDER_COLOR),
    rows: rows.map(
      (cells) =>
        new TableRow({
          tableHeader: cells.every((cell) => cell.header),
          children: cells.map(
            (cell) =>
              new TableCell({
                children: cellParagraphs(cell),
                shading: cell.header ? { type: ShadingType.CLEAR, fill: HEADER_BG } : undefined,
                margins: { top: 60, bottom: 60, left: 120, right: 120 },
              }),
          ),
        }),
    ),
  });
}

function convertBlocks(blocks: readonly DocBlock[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let listInstance = 0;

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        out.push(
          new Paragraph({
            children: inlineChildren(block.children),
            heading: HEADING_LEVELS[Math.min(Math.max(block.level, 1), 6) - 1],
          }),
        );
        break;

      case 'paragraph':
        out.push(
          new Paragraph({
            children: inlineChildren(block.children),
            ...(block.quote
              ? {
                  indent: { left: convertMillimetersToTwip(6) },
                  border: { left: { style: BorderStyle.SINGLE, size: 12, color: BORDER_COLOR, space: 8 } },
                }
              : {}),
          }),
        );
        break;

      case 'list': {
        listInstance += 1;
        for (const item of block.items) out.push(listParagraph(item, listInstance));
        break;
      }

      case 'code':
        out.push(codeTable(block.lines));
        // 표 바로 뒤에 문단이 없으면 Word가 표를 붙여 버리므로 여백용 빈 문단을 둔다
        out.push(new Paragraph({ children: [], spacing: { after: 0, line: 120 } }));
        break;

      case 'table':
        out.push(docTable(block.rows));
        out.push(new Paragraph({ children: [], spacing: { after: 0, line: 120 } }));
        break;

      case 'mathblock':
        out.push(
          new Paragraph({
            children: mathChildren(block.math, block.tex, true),
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
          }),
        );
        break;

      case 'imageblock': {
        const image = imageRun(block.src, block.width, block.height);
        out.push(
          new Paragraph({
            children: image
              ? [image]
              : [new TextRun({ text: `[이미지: ${block.alt || block.src}]`, italics: true, color: MUTED_COLOR })],
            alignment: AlignmentType.CENTER,
          }),
        );
        break;
      }

      case 'rule':
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BORDER_COLOR, space: 4 } },
          }),
        );
        break;

      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 문서 조립
// ---------------------------------------------------------------------------
function headingStyle(size: number, before: number): {
  run: { font: typeof BODY_FONT; size: number; bold: true; color: string };
  paragraph: { spacing: { before: number; after: number } };
} {
  return {
    run: { font: BODY_FONT, size, bold: true, color: TEXT_COLOR },
    paragraph: { spacing: { before, after: 120 } },
  };
}

/** DocModel -> .docx 바이트 */
export async function buildDocx(model: DocModel): Promise<Buffer> {
  const doc = new Document({
    title: model.title,
    creator: 'Markdown Viewer',
    description: 'Markdown Viewer에서 내보낸 문서',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE, color: TEXT_COLOR },
          paragraph: { spacing: { line: 312, after: 120 } }, // 줄간격 1.3
        },
        heading1: headingStyle(40, 360),
        heading2: headingStyle(32, 320),
        heading3: headingStyle(28, 280),
        heading4: headingStyle(24, 240),
        heading5: headingStyle(22, 240),
        heading6: headingStyle(22, 240),
      },
    },
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['●', '○', '▪', '·', '-'][level],
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
        {
          reference: NUMBER_REF,
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER][level],
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(PAGE_MARGIN_MM),
              bottom: convertMillimetersToTwip(PAGE_MARGIN_MM),
              left: convertMillimetersToTwip(PAGE_MARGIN_MM),
              right: convertMillimetersToTwip(PAGE_MARGIN_MM),
            },
          },
        },
        children: convertBlocks(model.blocks),
      },
    ],
  });

  return Packer.toBuffer(doc);
}
