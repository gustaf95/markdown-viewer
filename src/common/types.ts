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
  | 'save-close';

/** 파일 저장 결과 */
export interface SaveResult {
  ok: boolean;
  error?: string;
  savedAt?: number;
  /** 저장에 사용된 인코딩 */
  encoding?: string;
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
  /** 저장되지 않은 변경 여부를 main에 알림 (닫기 확인 대화상자용) */
  notifyDirty(dirty: boolean): void;
  /** 닫기 전 저장(save-close) 처리 결과 전달: 'close'면 창을 닫고 'cancel'이면 유지 */
  resolveClose(action: 'close' | 'cancel'): void;
  onFileOpened(cb: (payload: FileOpenedPayload) => void): void;
  onFileError(cb: (payload: FileErrorPayload) => void): void;
  onCommand(cb: (cmd: AppCommand) => void): void;
}
