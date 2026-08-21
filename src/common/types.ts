import type { DocModel } from './docmodel';

/** 파일이 열렸을 때 main -> renderer 로 전달되는 페이로드 */
export interface FileOpenedPayload {
  /** 파일의 절대 경로 */
  filePath: string;
  /** 파일명 (확장자 포함) */
  fileName: string;
  /** 파일이 위치한 디렉터리의 file:// URL (상대 경로 이미지 해석 기준) */
  dirUrl: string;
  /** 디코딩된 Markdown 원문 */
  content: string;
  /** 실제 사용된 인코딩 (예: 'utf-8', 'utf-8 (bom)', 'cp949') */
  encoding: string;
  /** 열림 사유: open(사용자 열기) / reload(수동 새로고침) / watch(파일 변경 감지) */
  reason: 'open' | 'reload' | 'watch';
  /** 갱신 시각 (epoch ms) */
  updatedAt: number;
}

export interface FileErrorPayload {
  message: string;
}

/** 메뉴/단축키 -> renderer 명령 */
export type AppCommand =
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'theme-toggle'
  | 'edit-toggle'
  | 'save'
  | 'save-close'
  | 'print'
  | 'export-html'
  | 'export-docx'
  | 'export-hwpx'
  | 'import-docx';

/** 파일 저장 결과 */
export interface SaveResult {
  ok: boolean;
  error?: string;
  savedAt?: number;
  /** 저장에 사용된 인코딩 */
  encoding?: string;
}

/** 인쇄 결과 */
export interface PrintResult {
  ok: boolean;
  /** 사용자가 인쇄 대화상자를 취소한 경우 true */
  canceled?: boolean;
  error?: string;
}

/** 내보내기 형식 (F-1101~) */
export type ExportFormat = 'html' | 'docx' | 'hwpx';

/** renderer -> main 내보내기 요청 */
export interface ExportRequest {
  format: ExportFormat;
  /** 문서 제목 (HTML의 <title>, DOCX/HWPX 문서 속성에 사용) */
  title: string;
  /** html 형식: 내보낼 본문 HTML (sanitize된 #content의 innerHTML, 앱 전용 UI 제거 상태) */
  html?: string;
  /** docx/hwpx 형식: 보기용 DOM에서 만든 중간 문서 모델 */
  doc?: DocModel;
}

/** 내보내기 결과 */
export interface ExportResult {
  ok: boolean;
  /** 사용자가 저장 대화상자를 취소한 경우 true */
  canceled?: boolean;
  /** 저장된 파일 경로 */
  filePath?: string;
  error?: string;
}

/** 가져오기 형식 (F-1201~) — HWPX·HTML은 추후 확장 */
export type ImportFormat = 'docx';

/** main -> renderer 로 넘기는 DOCX 부품 (renderer가 DOMParser로 해석한다) */
export interface DocxImportPayload {
  /** 원본 파일 경로 (가져온 뒤 저장 위치 제안에 쓴다) */
  filePath: string;
  document: string;
  styles?: string;
  numbering?: string;
  rels?: string;
  /** media 파일명 -> data URI */
  media?: Record<string, string>;
}

/** 가져오기 결과 */
export interface ImportResult {
  ok: boolean;
  /** 사용자가 파일 선택을 취소한 경우 true */
  canceled?: boolean;
  error?: string;
  payload?: DocxImportPayload;
}

/** 인코딩 강제 지정 값 ('auto'면 자동 감지) */
export type EncodingChoice = 'auto' | 'utf-8' | 'cp949' | 'euc-kr' | 'utf-16le';

/** preload가 contextBridge로 노출하는 API */
export interface MdvApi {
  openFileDialog(): Promise<void>;
  openPath(filePath: string): Promise<void>;
  /** encoding 미지정 시 현재 설정 유지, 'auto'면 자동 감지로 복귀 */
  reload(encoding?: EncodingChoice): Promise<void>;
  getRecentFiles(): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  getPathForFile(file: File): string;
  /** 편집 내용을 현재 파일에 원래 인코딩 그대로 저장 */
  saveFile(content: string): Promise<SaveResult>;
  /** 현재 보고 있는 문서를 인쇄 (시스템 인쇄 대화상자 표시) */
  print(): Promise<PrintResult>;
  /** 현재 문서를 지정한 형식으로 내보내기 (저장 위치는 main의 대화상자에서 선택) */
  exportDocument(request: ExportRequest): Promise<ExportResult>;
  /** 다른 형식의 문서를 열어 Markdown으로 가져오기 (파일 선택은 main의 대화상자) */
  importDocument(format: ImportFormat): Promise<ImportResult>;
  /** 저장되지 않은 변경 여부를 main에 알림 (닫기 확인 대화상자용) */
  notifyDirty(dirty: boolean): void;
  /** 닫기 전 저장(save-close) 처리 결과 전달: 'close'면 창을 닫고 'cancel'이면 유지 */
  resolveClose(action: 'close' | 'cancel'): void;
  onFileOpened(cb: (payload: FileOpenedPayload) => void): void;
  onFileError(cb: (payload: FileErrorPayload) => void): void;
  onCommand(cb: (cmd: AppCommand) => void): void;
}
