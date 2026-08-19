// ---------------------------------------------------------------------------
// 내보내기용 중간 문서 모델 (F-1102)
//  - renderer가 보기용 DOM에서 만들고(브라우저 DOM 사용), main이 포맷별로 변환한다.
//    renderer는 sandbox라 파일을 쓸 수 없고, main에는 DOM/HTML 파서가 없으므로
//    "DOM 해석은 renderer, 파일 생성은 main"으로 역할을 나눈다.
//  - DOCX/HWPX가 이 모델을 공유한다.
// ---------------------------------------------------------------------------

/** MathML 요소를 그대로 옮긴 트리 (KaTeX가 만든 <math>에서 추출) */
export interface MathNode {
  /** 네임스페이스를 뗀 소문자 태그명 (mi, mo, mfrac ...) */
  tag: string;
  attrs?: Record<string, string>;
  /** 잎 노드의 텍스트 */
  text?: string;
  children?: MathNode[];
}

export interface DocText {
  kind: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** 인라인 코드 (`code`) — 고정폭 글꼴 + 음영 */
  code?: boolean;
  /** 구문 강조 색상 (#rrggbb, 코드 블록 전용) */
  color?: string;
}

export interface DocLink {
  kind: 'link';
  href: string;
  children: DocInline[];
}

/** 인라인 수식 */
export interface DocMath {
  kind: 'math';
  math: MathNode;
  /** KaTeX가 남긴 원본 LaTeX (변환 실패 시 대체 표기로 사용) */
  tex?: string;
}

export interface DocImage {
  kind: 'image';
  /** file:// / data: / http(s) URL */
  src: string;
  alt: string;
  /** 원본 픽셀 크기 (0이면 알 수 없음) */
  width: number;
  height: number;
}

/** 줄바꿈 (<br>) */
export interface DocBreak {
  kind: 'break';
}

export type DocInline = DocText | DocLink | DocMath | DocImage | DocBreak;

export interface DocParagraph {
  kind: 'paragraph';
  children: DocInline[];
  /** 인용문(blockquote) 안의 문단 */
  quote?: boolean;
}

export interface DocHeading {
  kind: 'heading';
  /** 1~6 */
  level: number;
  children: DocInline[];
}

export interface DocListItem {
  /** 중첩 깊이 (0부터) */
  level: number;
  ordered: boolean;
  children: DocInline[];
  /** 체크박스 목록이면 체크 여부, 아니면 undefined */
  checked?: boolean;
}

export interface DocList {
  kind: 'list';
  items: DocListItem[];
}

/** 코드 블록의 한 줄 (구문 강조 색상을 가진 조각들) */
export interface DocCodeLine {
  runs: DocText[];
}

export interface DocCode {
  kind: 'code';
  language?: string;
  lines: DocCodeLine[];
}

export interface DocTableCell {
  children: DocInline[];
  header?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface DocTable {
  kind: 'table';
  rows: DocTableCell[][];
}

/** 블록(디스플레이) 수식 */
export interface DocMathBlock {
  kind: 'mathblock';
  math: MathNode;
  tex?: string;
}

export interface DocImageBlock extends Omit<DocImage, 'kind'> {
  kind: 'imageblock';
}

/** 수평선 */
export interface DocRule {
  kind: 'rule';
}

export type DocBlock =
  | DocParagraph
  | DocHeading
  | DocList
  | DocCode
  | DocTable
  | DocMathBlock
  | DocImageBlock
  | DocRule;

export interface DocModel {
  title: string;
  blocks: DocBlock[];
}
