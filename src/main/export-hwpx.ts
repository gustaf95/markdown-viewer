import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  DocBlock,
  DocCodeLine,
  DocInline,
  DocListItem,
  DocModel,
  DocTableCell,
  DocText,
} from '../common/docmodel';
import { mathToHwpScript } from './hwp-eqn';
import { buildZip } from './zip';
import type { ZipEntry } from './zip';

// ---------------------------------------------------------------------------
// HWPX(한글) 내보내기 (F-1103)
//  - HWPX는 OWPML(XML) 여러 개를 ZIP으로 묶은 개방형 문서 형식이다 (KS X 6101).
//    성숙한 JS 라이브러리가 없어 XML을 직접 만들고 zip.ts로 묶는다.
//  - 입력은 DOCX와 같은 DocModel이라 renderer 쪽은 손댈 게 없다.
//  - 수식은 <hp:equation><hp:script>에 한글 수식 스크립트를 넣어 **네이티브 수식 개체**로
//    만든다 (hwp-eqn.ts). 이미지가 아니므로 한글에서 확대·편집해도 깨지지 않는다.
//  - 구조와 속성값은 한글 2020이 실제로 저장한 파일을 뜯어 맞췄다.
// ---------------------------------------------------------------------------

/** HWPUNIT = 1/7200인치. 1mm = 283.46, 1pt = 100 */
const MM = 7200 / 25.4;
const PAGE_WIDTH = Math.round(210 * MM); // A4
const PAGE_HEIGHT = Math.round(297 * MM);
const PAGE_MARGIN = Math.round(20 * MM);
const HEADER_MARGIN = Math.round(15 * MM);
/** 본문이 들어갈 수 있는 가로 폭 */
const TEXT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

/** 글자 크기는 1/100 pt */
const BODY_SIZE = 1050;
const CODE_SIZE = 900;
const HEADING_SIZES = [2000, 1600, 1400, 1200, 1100, 1050];

const TEXT_COLOR = '#1F2328';
const MUTED_COLOR = '#59636E';
const LINK_COLOR = '#0969DA';
const CODE_COLOR = '#C0392B';
const CODE_BG = '#F6F8FA';
const HEADER_BG = '#F3F4F6';

/** 글꼴 목록에서의 자리 — 0=본문, 1=고정폭 */
const FONT_BODY = 0;
const FONT_MONO = 1;

/** 미리 정해 둔 테두리/배경 묶음 (header.xml의 borderFill id) */
const BF_NONE = 1;
const BF_CHAR = 2; // charPr가 가리키는 기본값
const BF_CODE = 3; // 코드 블록 배경
const BF_CELL = 4; // 표 안쪽 칸
const BF_CELL_HEAD = 5; // 표 머리 칸
const BF_QUOTE = 6; // 인용문 왼쪽 세로줄
const BF_RULE = 7; // 수평선

/** 한글이 바로 받는 형식만. SVG·WebP는 자리 표시 글자로 대신한다 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

// ---------------------------------------------------------------------------
// XML 조립
// ---------------------------------------------------------------------------
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 한글이 읽지 못하는 제어 문자는 버린다 (탭·줄바꿈은 살린다)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

/** 한글이 모든 OWPML 파일의 루트에 붙이는 네임스페이스 묶음 */
const NS = [
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history"',
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"',
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:opf="http://www.idpf.org/2007/opf/"',
  'xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"',
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"',
  'xmlns:epub="http://www.idpf.org/2007/ops"',
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"',
].join(' ');

// ---------------------------------------------------------------------------
// 글자/문단 모양 등록부
//  - 한글은 서식을 문단·글자마다 적지 않고 header.xml의 목록을 번호로 가리킨다.
//    같은 모양은 한 번만 만들도록 내용을 열쇠로 삼아 중복을 없앤다.
// ---------------------------------------------------------------------------
interface CharStyle {
  font?: number;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  color?: string;
  shade?: string;
}

interface ParaStyle {
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  /** 왼쪽 들여쓰기 (HWPUNIT) */
  left?: number;
  /** 문단 앞/뒤 여백 (HWPUNIT) */
  prev?: number;
  next?: number;
  /** 줄간격 % */
  lineSpacing?: number;
  borderFill?: number;
  /** 이어지는 문단끼리 테두리를 하나로 (코드 블록) */
  connect?: boolean;
}

class Registry<T> {
  private readonly keys: string[] = [];
  readonly items: T[] = [];

  id(item: T): number {
    const key = JSON.stringify(item);
    const found = this.keys.indexOf(key);
    if (found >= 0) return found;
    this.keys.push(key);
    this.items.push(item);
    return this.items.length - 1;
  }
}

function charPrXml(style: CharStyle, id: number): string {
  const font = style.font ?? FONT_BODY;
  const langs = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
  const perLang = (value: string | number): string => langs.map((l) => `${l}="${value}"`).join(' ');
  const parts = [
    `<hh:fontRef ${perLang(font)}/>`,
    `<hh:ratio ${perLang(100)}/>`,
    `<hh:spacing ${perLang(0)}/>`,
    `<hh:relSz ${perLang(100)}/>`,
    `<hh:offset ${perLang(0)}/>`,
  ];
  // 순서가 스키마에 정해져 있다 (italic 다음 bold). 뒤집으면 한글이 파일을 거부한다
  if (style.italic) parts.push('<hh:italic/>');
  if (style.bold) parts.push('<hh:bold/>');
  parts.push(
    `<hh:underline type="${style.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="${style.color ?? TEXT_COLOR}"/>`,
    `<hh:strikeout shape="${style.strike ? 'SOLID' : 'NONE'}" color="${style.color ?? TEXT_COLOR}"/>`,
    '<hh:outline type="NONE"/>',
    '<hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>',
  );
  return (
    `<hh:charPr id="${id}" height="${style.size ?? BODY_SIZE}" textColor="${style.color ?? TEXT_COLOR}"` +
    ` shadeColor="${style.shade ?? 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="${BF_CHAR}">` +
    parts.join('') +
    '</hh:charPr>'
  );
}

function paraPrXml(style: ParaStyle, id: number): string {
  // 여백/줄간격 묶음은 한글이 구버전 호환용 switch로 감싸 두므로 같은 모양을 따른다
  const margin =
    '<hh:margin>' +
    '<hc:intent value="0" unit="HWPUNIT"/>' +
    `<hc:left value="${style.left ?? 0}" unit="HWPUNIT"/>` +
    '<hc:right value="0" unit="HWPUNIT"/>' +
    `<hc:prev value="${style.prev ?? 0}" unit="HWPUNIT"/>` +
    `<hc:next value="${style.next ?? 0}" unit="HWPUNIT"/>` +
    '</hh:margin>' +
    `<hh:lineSpacing type="PERCENT" value="${style.lineSpacing ?? 130}" unit="HWPUNIT"/>`;
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
    `<hh:align horizontal="${style.align ?? 'JUSTIFY'}" vertical="BASELINE"/>` +
    '<hh:heading type="NONE" idRef="0" level="0"/>' +
    '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>' +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    '<hp:switch>' +
    '<hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">' +
    margin +
    '</hp:case>' +
    '<hp:default>' +
    margin +
    '</hp:default>' +
    '</hp:switch>' +
    `<hh:border borderFillIDRef="${style.borderFill ?? BF_NONE}" offsetLeft="${style.borderFill ? 300 : 0}" offsetRight="${style.borderFill ? 300 : 0}"` +
    ` offsetTop="0" offsetBottom="0" connect="${style.connect ? 1 : 0}" ignoreMargin="0"/>` +
    '</hh:paraPr>'
  );
}

// ---------------------------------------------------------------------------
// 본문 만들기
// ---------------------------------------------------------------------------
interface BinaryItem {
  id: string;
  fileName: string;
  mediaType: string;
  data: Buffer;
}

class SectionBuilder {
  readonly charPrs = new Registry<CharStyle>();
  readonly paraPrs = new Registry<ParaStyle>();
  readonly binaries: BinaryItem[] = [];
  private readonly out: string[] = [];
  private paraId = 0;
  private shapeId = 0x40000000;
  private zOrder = 0;
  /** 첫 문단에는 쪽 설정(secPr)이 들어가야 한다 */
  private needSecPr = true;
  /** 미리보기용 본문 글 */
  readonly plainText: string[] = [];

  constructor() {
    // id 0은 언제나 기본 본문 모양이 되도록 먼저 등록한다
    this.charPrs.id({});
    this.paraPrs.id({});
  }

  private nextShapeId(): number {
    this.shapeId += 1;
    return this.shapeId;
  }

  /**
   * 문단 하나.
   * 한글은 문단마다 줄 배치를 캐시한 <hp:linesegarray>를 남기지만 표준에는 없는 정보이고,
   * 우리가 줄바꿈 위치를 미리 알 수 없어 캐시를 만들면 오히려 글자가 겹친다.
   * 넣지 않으면 한글이 파일을 열 때 스스로 계산한다.
   */
  paragraph(runs: string, para: ParaStyle): void {
    const paraPrId = this.paraPrs.id(para);
    const lead = this.needSecPr ? this.secPrRun() : '';
    this.needSecPr = false;
    this.out.push(
      `<hp:p id="${this.paraId += 1}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
        lead +
        (runs || '<hp:run charPrIDRef="0"><hp:t/></hp:run>') +
        '</hp:p>',
    );
  }

  /** 글자 조각 하나 */
  run(text: string, style: CharStyle): string {
    const id = this.charPrs.id(style);
    return `<hp:run charPrIDRef="${id}"><hp:t>${esc(text)}</hp:t></hp:run>`;
  }

  /** 수식 개체 — 한글의 네이티브 수식으로 들어간다 */
  equation(script: string, size: number): string {
    const id = this.charPrs.id({ size });
    // 한글은 파일을 열 때 수식 크기를 다시 계산하므로 여기 값은 어림잡아도 된다.
    // (일부러 틀린 값을 넣고 열어 봐도 조판 결과가 같았다)
    const height = Math.round(size * 2.4);
    const width = Math.min(Math.max(script.length * Math.round(size * 0.42), size * 4), TEXT_WIDTH);
    return (
      `<hp:run charPrIDRef="${id}">` +
      `<hp:equation id="${this.nextShapeId()}" zOrder="${this.zOrder += 1}" numberingType="EQUATION"` +
      ' textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None"' +
      ` version="Equation Version 60" baseLine="63" textColor="${TEXT_COLOR}"` +
      ` baseUnit="${size}" lineMode="CHAR" font="HancomEQN">` +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0"' +
      ' vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="56" right="56" top="0" bottom="0"/>' +
      `<hp:script>${esc(script)}</hp:script>` +
      '</hp:equation>' +
      '<hp:t/></hp:run>'
    );
  }

  /** 그림 개체 — 바이너리는 BinData/에 따로 담긴다 */
  picture(item: BinaryItem, widthPx: number, heightPx: number): string {
    const PX = 7200 / 96; // 96dpi 픽셀 -> HWPUNIT
    let width = Math.round(widthPx * PX);
    let height = Math.round(heightPx * PX);
    if (width > TEXT_WIDTH) {
      height = Math.round((height * TEXT_WIDTH) / width);
      width = TEXT_WIDTH;
    }
    const id = this.nextShapeId();
    return (
      '<hp:run charPrIDRef="0">' +
      `<hp:pic id="${id}" zOrder="${this.zOrder += 1}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM"` +
      ` textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0">` +
      '<hp:offset x="0" y="0"/>' +
      `<hp:orgSz width="${width}" height="${height}"/>` +
      `<hp:curSz width="${width}" height="${height}"/>` +
      '<hp:flip horizontal="0" vertical="0"/>' +
      `<hp:rotationInfo angle="0" centerX="${Math.round(width / 2)}" centerY="${Math.round(height / 2)}" rotateimage="1"/>` +
      '<hp:renderingInfo>' +
      '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
      '</hp:renderingInfo>' +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/>` +
      '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
      `<hp:imgDim dimwidth="${width}" dimheight="${height}"/>` +
      `<hc:img binaryItemIDRef="${item.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      '<hp:effects/>' +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0"' +
      ' vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      '</hp:pic>' +
      '<hp:t/></hp:run>'
    );
  }

  /** 표 개체. 칸 안은 다시 문단 목록(subList)이다 */
  table(rowsXml: string, rows: number, cols: number): string {
    const id = this.nextShapeId();
    const height = rows * 1200;
    return (
      '<hp:run charPrIDRef="0">' +
      `<hp:tbl id="${id}" zOrder="${this.zOrder += 1}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM"` +
      ' textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1"' +
      ` rowCnt="${rows}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${BF_CELL}" noAdjust="0">` +
      `<hp:sz width="${TEXT_WIDTH}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0"' +
      ' vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      '<hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
      rowsXml +
      '</hp:tbl>' +
      '<hp:t/></hp:run>'
    );
  }

  /** 표 칸 안의 문단 */
  cellParagraph(runs: string, para: ParaStyle): string {
    const paraPrId = this.paraPrs.id(para);
    return (
      `<hp:p id="${this.paraId += 1}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
      (runs || '<hp:run charPrIDRef="0"><hp:t/></hp:run>') +
      '</hp:p>'
    );
  }

  addBinary(data: Buffer, ext: string): BinaryItem {
    const index = this.binaries.length + 1;
    const item: BinaryItem = {
      id: `image${index}`,
      fileName: `image${index}.${ext}`,
      mediaType: `image/${ext}`,
      data,
    };
    this.binaries.push(item);
    return item;
  }

  /** 쪽 설정 — 문서에서 딱 한 번, 첫 문단 안에 들어간다 */
  private secPrRun(): string {
    const noteNumbering =
      '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
      '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>' +
      '<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>' +
      '<hp:numbering type="CONTINUOUS" newNum="1"/>';
    const borderFills = ['BOTH', 'EVEN', 'ODD']
      .map(
        (type) =>
          `<hp:pageBorderFill type="${type}" borderFillIDRef="${BF_NONE}" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">` +
          '<hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>',
      )
      .join('');
    return (
      '<hp:run charPrIDRef="0">' +
      '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT"' +
      ' outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
      '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
      '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
      '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL"' +
      ' hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
      '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
      `<hp:pagePr landscape="WIDELY" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${HEADER_MARGIN}" footer="${HEADER_MARGIN}" gutter="0" left="${PAGE_MARGIN}" right="${PAGE_MARGIN}"` +
      ` top="${PAGE_MARGIN}" bottom="${PAGE_MARGIN}"/>` +
      '</hp:pagePr>' +
      `<hp:footNotePr>${noteNumbering}<hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
      `<hp:endNotePr>${noteNumbering}<hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
      borderFills +
      '</hp:secPr>' +
      '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>' +
      '</hp:run>'
    );
  }

  xml(): string {
    // 빈 문서라도 문단이 하나는 있어야 쪽 설정이 들어간다
    if (this.out.length === 0) this.paragraph('', {});
    return `${XML_DECL}<hs:sec ${NS}>${this.out.join('')}</hs:sec>`;
  }
}

// ---------------------------------------------------------------------------
// DocModel -> 본문
// ---------------------------------------------------------------------------
/** 이미지 원본 바이트를 확보한다 (data URI / 로컬 파일). 실패하면 null */
function readImage(src: string): { data: Buffer; ext: string } | null {
  try {
    if (/^data:/i.test(src)) {
      const match = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(src);
      if (!match) return null;
      const kind = match[1].toLowerCase();
      const ext = IMAGE_TYPES[`.${kind}`];
      if (!ext) return null;
      return { data: Buffer.from(match[2], 'base64'), ext };
    }
    if (/^file:/i.test(src)) {
      const filePath = fileURLToPath(src);
      const ext = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
      if (!ext) return null;
      return { data: fs.readFileSync(filePath), ext };
    }
  } catch {
    return null;
  }
  return null; // http(s) 이미지는 내려받지 않는다
}

class DocConverter {
  constructor(private readonly sec: SectionBuilder) {}

  /** 인라인 조각들 -> hp:run 묶음 */
  private inlines(items: readonly DocInline[], base: CharStyle = {}): string {
    let out = '';
    for (const item of items) {
      switch (item.kind) {
        case 'text':
          out += this.text(item, base);
          break;
        case 'break':
          // 한글에는 문단 안 강제 줄바꿈을 나타낼 마땅한 방법이 없어 공백으로 잇는다
          out += this.sec.run(' ', base);
          break;
        case 'link': {
          // 하이퍼링크는 필드 컨트롤이라 구조가 복잡해 v1에서는 모양만 살린다
          const style = { ...base, color: LINK_COLOR, underline: true };
          out += this.inlines(item.children, style);
          break;
        }
        case 'math': {
          const script = mathToHwpScript(item.math);
          out += script
            ? this.sec.equation(script, base.size ?? BODY_SIZE)
            : this.sec.run(item.tex ?? '', { ...base, font: FONT_MONO, color: MUTED_COLOR });
          break;
        }
        case 'image':
          out += this.image(item.src, item.alt, item.width, item.height, base);
          break;
        default:
          break;
      }
    }
    return out;
  }

  private text(run: DocText, base: CharStyle): string {
    if (run.text.length === 0) return '';
    const style: CharStyle = {
      ...base,
      bold: run.bold || base.bold,
      italic: run.italic || base.italic,
      strike: run.strike || base.strike,
    };
    if (run.code) {
      style.font = FONT_MONO;
      style.color = base.color ?? CODE_COLOR;
      style.shade = CODE_BG;
    }
    if (run.color) style.color = `#${run.color}`;
    return this.sec.run(run.text, style);
  }

  private image(src: string, alt: string, width: number, height: number, base: CharStyle): string {
    const image = readImage(src);
    if (!image) {
      // 한글이 바로 받지 못하는 형식이거나 읽지 못한 이미지는 자리만 알려 준다
      return this.sec.run(`[이미지: ${alt || src}]`, { ...base, italic: true, color: MUTED_COLOR });
    }
    const item = this.sec.addBinary(image.data, image.ext);
    return this.sec.picture(item, width > 0 ? width : 480, height > 0 ? height : 360);
  }

  /** 번호 목록의 수준별 일련번호 — 상위 수준으로 돌아가면 아래 수준은 다시 1부터 */
  private readonly counters: number[] = [];

  private listItem(item: DocListItem): void {
    this.counters.length = Math.max(this.counters.length, item.level + 1);
    this.counters[item.level] = (this.counters[item.level] ?? 0) + 1;
    for (let i = item.level + 1; i < this.counters.length; i += 1) this.counters[i] = 0;

    // 한글의 자동 문단 번호 대신 글머리 기호를 직접 찍는다.
    // 수준별 번호 매김을 header.xml에 붙이는 것보다 결과가 예측 가능하다.
    const marker =
      item.checked !== undefined
        ? item.checked
          ? '☑ '
          : '☐ '
        : item.ordered
          ? `${this.counters[item.level]}. `
          : `${['•', '◦', '▪', '·'][Math.min(item.level, 3)]} `;
    const runs = this.sec.run(marker, {}) + this.inlines(item.children);
    this.sec.paragraph(runs, {
      left: Math.round((item.level + 1) * 5 * MM),
      next: 40,
    });
  }

  private codeBlock(lines: readonly DocCodeLine[]): void {
    lines.forEach((line, index) => {
      const runs =
        line.runs.length > 0
          ? line.runs.map((run) => this.text(run, { font: FONT_MONO, size: CODE_SIZE })).join('')
          : this.sec.run(' ', { font: FONT_MONO, size: CODE_SIZE });
      this.sec.paragraph(
        runs,
        {
          lineSpacing: 110,
          left: Math.round(2 * MM),
          borderFill: BF_CODE,
          // 이어지는 줄들의 테두리를 하나로 묶어 블록처럼 보이게 한다
          connect: true,
          prev: index === 0 ? 120 : 0,
          next: index === lines.length - 1 ? 120 : 0,
        },
      );
    });
  }

  private table(rows: readonly DocTableCell[][]): void {
    const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (cols === 0) return;
    const cellWidth = Math.floor(TEXT_WIDTH / cols);
    const rowsXml = rows
      .map((cells, rowIndex) => {
        const tcs = cells
          .map((cell, colIndex) => {
            const align =
              cell.align === 'center' ? 'CENTER' : cell.align === 'right' ? 'RIGHT' : 'LEFT';
            const runs = this.inlines(cell.children, cell.header ? { bold: true } : {});
            const inner = this.sec.cellParagraph(runs, { align, lineSpacing: 130 });
            return (
              `<hp:tc name="" header="${cell.header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0"` +
              ` borderFillIDRef="${cell.header ? BF_CELL_HEAD : BF_CELL}">` +
              '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0"' +
              ' linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
              inner +
              '</hp:subList>' +
              `<hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}"/>` +
              '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
              `<hp:cellSz width="${cellWidth}" height="1200"/>` +
              '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>' +
              '</hp:tc>'
            );
          })
          .join('');
        return `<hp:tr>${tcs}</hp:tr>`;
      })
      .join('');
    this.sec.paragraph(this.sec.table(rowsXml, rows.length, cols), { prev: 120, next: 120 });
  }

  block(block: DocBlock): void {
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(Math.max(block.level, 1), 6);
        const size = HEADING_SIZES[level - 1];
        this.sec.paragraph(
          this.inlines(block.children, { size, bold: true }),
          { prev: level <= 2 ? 400 : 300, next: 150, align: 'LEFT' },
        );
        break;
      }

      case 'paragraph':
        this.sec.paragraph(
          this.inlines(block.children, block.quote ? { color: MUTED_COLOR } : {}),
          block.quote
            ? { left: Math.round(6 * MM), borderFill: BF_QUOTE, next: 100 }
            : { next: 150 },
        );
        break;

      case 'list':
        this.counters.length = 0; // 목록마다 번호를 다시 센다
        for (const item of block.items) this.listItem(item);
        break;

      case 'code':
        this.codeBlock(block.lines);
        break;

      case 'table':
        this.table(block.rows);
        break;

      case 'mathblock': {
        const script = mathToHwpScript(block.math);
        const runs = script
          ? this.sec.equation(script, BODY_SIZE)
          : this.sec.run(block.tex ?? '', { font: FONT_MONO, color: MUTED_COLOR });
        this.sec.paragraph(runs, { align: 'CENTER', prev: 150, next: 150 });
        break;
      }

      case 'imageblock':
        this.sec.paragraph(this.image(block.src, block.alt, block.width, block.height, {}), {
          align: 'CENTER',
          prev: 120,
          next: 120,
        });
        break;

      case 'rule':
        this.sec.paragraph('', { borderFill: BF_RULE, prev: 200, next: 200 });
        break;

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// header.xml
// ---------------------------------------------------------------------------
function borderFillsXml(): string {
  const line = (type: string, width = '0.12 mm', color = '#D1D9E0'): string =>
    `type="${type}" width="${width}" color="${color}"`;
  const fill = (color: string): string =>
    `<hc:fillBrush><hc:winBrush faceColor="${color}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
  const make = (id: number, sides: Record<string, string>, brush = ''): string =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    `<hh:leftBorder ${sides.left}/><hh:rightBorder ${sides.right}/><hh:topBorder ${sides.top}/><hh:bottomBorder ${sides.bottom}/>` +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    brush +
    '</hh:borderFill>';

  const none = line('NONE', '0.1 mm', '#000000');
  const solid = line('SOLID');
  const allNone = { left: none, right: none, top: none, bottom: none };
  const allSolid = { left: solid, right: solid, top: solid, bottom: solid };

  return (
    '<hh:borderFills itemCnt="7">' +
    make(BF_NONE, allNone) +
    make(BF_CHAR, allNone, fill('none')) +
    make(BF_CODE, allSolid, fill(CODE_BG)) +
    make(BF_CELL, allSolid) +
    make(BF_CELL_HEAD, allSolid, fill(HEADER_BG)) +
    make(BF_QUOTE, { ...allNone, left: line('SOLID', '0.5 mm') }) +
    make(BF_RULE, { ...allNone, bottom: line('SOLID', '0.12 mm') }) +
    '</hh:borderFills>'
  );
}

function fontFacesXml(): string {
  // 한글은 언어별로 글꼴 목록을 따로 갖는다. 자리(id)는 모든 언어에서 같아야
  // charPr의 fontRef 하나로 가리킬 수 있다. 0=본문, 1=고정폭.
  const byLang: Record<string, readonly string[]> = {
    HANGUL: ['맑은 고딕', 'D2Coding'],
    LATIN: ['Malgun Gothic', 'Consolas'],
    HANJA: ['맑은 고딕', 'D2Coding'],
    JAPANESE: ['맑은 고딕', 'D2Coding'],
    OTHER: ['Malgun Gothic', 'Consolas'],
    SYMBOL: ['맑은 고딕', 'D2Coding'],
    USER: ['맑은 고딕', 'D2Coding'],
  };
  const typeInfo =
    '<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1"' +
    ' armStyle="1" letterform="1" midline="1" xHeight="1"/>';
  const faces = Object.entries(byLang)
    .map(
      ([lang, fonts]) =>
        `<hh:fontface lang="${lang}" fontCnt="${fonts.length}">` +
        fonts
          .map(
            (face, id) =>
              `<hh:font id="${id}" face="${esc(face)}" type="TTF" isEmbedded="0">${typeInfo}</hh:font>`,
          )
          .join('') +
        '</hh:fontface>',
    )
    .join('');
  return `<hh:fontfaces itemCnt="7">${faces}</hh:fontfaces>`;
}

function buildHeaderXml(sec: SectionBuilder): string {
  const charPrs = sec.charPrs.items.map((style, id) => charPrXml(style, id)).join('');
  const paraPrs = sec.paraPrs.items.map((style, id) => paraPrXml(style, id)).join('');
  return (
    `${XML_DECL}<hh:head ${NS} version="1.4" secCnt="1">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    '<hh:refList>' +
    fontFacesXml() +
    borderFillsXml() +
    `<hh:charProperties itemCnt="${sec.charPrs.items.length}">${charPrs}</hh:charProperties>` +
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
    `<hh:paraProperties itemCnt="${sec.paraPrs.items.length}">${paraPrs}</hh:paraProperties>` +
    '<hh:styles itemCnt="1">' +
    '<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>' +
    '</hh:styles>' +
    '</hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="0"/>' +
    '</hh:head>'
  );
}

// ---------------------------------------------------------------------------
// 나머지 꾸러미 파일들
// ---------------------------------------------------------------------------
function buildContentHpf(title: string, binaries: readonly BinaryItem[]): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const items = [
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>',
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>',
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>',
    ...binaries.map(
      (item) =>
        `<opf:item id="${item.id}" href="BinData/${item.fileName}" media-type="${item.mediaType}" isEmbeded="1"/>`,
    ),
  ].join('');
  return (
    `${XML_DECL}<opf:package ${NS} version="" unique-identifier="" id="">` +
    '<opf:metadata>' +
    `<opf:title xml:space="preserve">${esc(title)}</opf:title>` +
    '<opf:language>ko</opf:language>' +
    '<opf:meta name="creator" content="text">Markdown Viewer</opf:meta>' +
    `<opf:meta name="CreatedDate" content="text">${now}</opf:meta>` +
    `<opf:meta name="ModifiedDate" content="text">${now}</opf:meta>` +
    '</opf:metadata>' +
    `<opf:manifest>${items}</opf:manifest>` +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>' +
    '</opf:package>'
  );
}

const VERSION_XML =
  `${XML_DECL}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version"` +
  ' tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4"' +
  ' application="Markdown Viewer" appVersion="1.0"/>';

const CONTAINER_XML =
  `${XML_DECL}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"` +
  ' xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>' +
  '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
  '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
  '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>' +
  '</ocf:rootfiles></ocf:container>';

const MANIFEST_XML =
  `${XML_DECL}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

const CONTAINER_RDF = ((): string => {
  const pkg = 'http://www.hancom.co.kr/hwpml/2016/meta/pkg#';
  const part = (href: string, type: string): string =>
    `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${pkg}" rdf:resource="${href}"/></rdf:Description>` +
    `<rdf:Description rdf:about="${href}"><rdf:type rdf:resource="${pkg}${type}"/></rdf:Description>`;
  return (
    `${XML_DECL}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    part('Contents/header.xml', 'HeaderFile') +
    part('Contents/section0.xml', 'SectionFile') +
    `<rdf:Description rdf:about=""><rdf:type rdf:resource="${pkg}Document"/></rdf:Description>` +
    '</rdf:RDF>'
  );
})();

const SETTINGS_XML =
  `${XML_DECL}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"` +
  ' xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">' +
  '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';

/** 한글 파일 목록에서 보이는 미리보기 글 */
function previewText(model: DocModel): string {
  const lines: string[] = [];
  for (const block of model.blocks) {
    if (lines.length >= 20) break;
    if (block.kind === 'heading' || block.kind === 'paragraph') {
      const text = block.children
        .map((c) => (c.kind === 'text' ? c.text : c.kind === 'link' ? c.children.map((g) => (g.kind === 'text' ? g.text : '')).join('') : ''))
        .join('')
        .trim();
      if (text) lines.push(text);
    }
  }
  return lines.join('\r\n').slice(0, 2000);
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------
/** DocModel -> .hwpx 바이트 */
export function buildHwpx(model: DocModel): Buffer {
  const sec = new SectionBuilder();
  const converter = new DocConverter(sec);
  for (const block of model.blocks) converter.block(block);

  const entries: ZipEntry[] = [
    // mimetype은 ODF 계열 규칙대로 맨 앞에 무압축으로 와야 한다
    { name: 'mimetype', data: Buffer.from('application/hwp+zip', 'utf8'), deflate: false },
    { name: 'version.xml', data: Buffer.from(VERSION_XML, 'utf8'), deflate: false },
    { name: 'Contents/header.xml', data: Buffer.from(buildHeaderXml(sec), 'utf8') },
    { name: 'Contents/section0.xml', data: Buffer.from(sec.xml(), 'utf8') },
    { name: 'Contents/content.hpf', data: Buffer.from(buildContentHpf(model.title, sec.binaries), 'utf8') },
    { name: 'settings.xml', data: Buffer.from(SETTINGS_XML, 'utf8') },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER_XML, 'utf8') },
    { name: 'META-INF/manifest.xml', data: Buffer.from(MANIFEST_XML, 'utf8') },
    { name: 'META-INF/container.rdf', data: Buffer.from(CONTAINER_RDF, 'utf8') },
    { name: 'Preview/PrvText.txt', data: Buffer.from(previewText(model), 'utf8') },
    ...sec.binaries.map((item) => ({ name: `BinData/${item.fileName}`, data: item.data })),
  ];

  return buildZip(entries);
}
