import { renderMarkdown } from './markdown';
import { createEditor, EditorHandle } from './editor';
import { buildDocModel } from './docmodel';
import { docxToDocModel } from './import-docx';
import { docModelToMarkdown } from '../common/docmodel-to-markdown';
import type { EncodingChoice, ExportFormat, FileOpenedPayload, ImportFormat, MdvApi } from '../common/types';

declare global {
  interface Window { mdv: MdvApi }
}

const mdv = window.mdv;

// ---------------------------------------------------------------------------
// DOM 참조
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const viewport = $('viewport');
const content = $('content');
const emptyState = $('empty-state');
const recentBox = $('recent-box');
const recentList = $('recent-list');
const loading = $('loading');
const loadingLabel = loading.querySelector('span') as HTMLSpanElement;
const toast = $('toast');
const fileNameLabel = $('file-name');
const zoomLabel = $('zoom-label');
const statusEncoding = $('status-encoding');
const statusZoom = $('status-zoom');
const statusUpdated = $('status-updated');
const encodingSelect = $('encoding-select') as unknown as HTMLSelectElement;
const themeButton = $('btn-theme');
const editorEl = $('editor');
const editButton = $('btn-edit');
const saveButton = $('btn-save');
const printButton = $('btn-print');

// ---------------------------------------------------------------------------
// 설정 저장 (F-804): 테마/배율은 localStorage에 유지
// ---------------------------------------------------------------------------
const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 10;

let zoom = clampZoom(Number(localStorage.getItem('mdv.zoom')) || 100);
let theme: 'light' | 'dark' = localStorage.getItem('mdv.theme') === 'dark' ? 'dark' : 'light';
let currentFile: FileOpenedPayload | null = null;

// ---------------------------------------------------------------------------
// 편집 모드 상태
// ---------------------------------------------------------------------------
let editMode = false;
let editorHandle: EditorHandle | null = null;
/** 편집 모드에서 보기 모드로 돌아왔을 때 아직 저장하지 않은 편집본 */
let draftMarkdown: string | null = null;
let dirty = false;
/** 인쇄 대화상자가 열려 있는 동안 중복 요청을 막는다 */
let printing = false;
/** 내보내기(저장 대화상자 + 변환)가 진행 중인 동안 중복 요청을 막는다 */
let exporting = false;
let importing = false;

function setDirty(next: boolean): void {
  if (dirty === next) return;
  dirty = next;
  mdv.notifyDirty(dirty);
  updateTitle();
}

function updateTitle(): void {
  if (!currentFile) return;
  const mark = dirty ? '● ' : '';
  document.title = `${mark}${currentFile.fileName} - Markdown Viewer`;
  fileNameLabel.textContent = `${mark}${currentFile.fileName}`;
}

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / ZOOM_STEP) * ZOOM_STEP));
}

function applyZoom(next: number): void {
  zoom = clampZoom(next);
  document.documentElement.style.setProperty('--zoom', String(zoom / 100));
  zoomLabel.textContent = `${zoom}%`;
  statusZoom.textContent = `${zoom}%`;
  localStorage.setItem('mdv.zoom', String(zoom));
}

/**
 * 테마별 스타일시트를 화면에 적용 (설정 저장 없음).
 * 인쇄할 때 다크 테마를 잠시 라이트로 되돌리는 데도 재사용한다.
 */
function applyThemeStyles(t: 'light' | 'dark'): void {
  document.body.dataset.theme = t;
  const lightCss = document.getElementById('hljs-light') as HTMLLinkElement;
  const darkCss = document.getElementById('hljs-dark') as HTMLLinkElement;
  lightCss.disabled = t === 'dark';
  darkCss.disabled = t === 'light';
  const mdLight = document.getElementById('milkdown-light') as HTMLLinkElement;
  const mdDark = document.getElementById('milkdown-dark') as HTMLLinkElement;
  mdLight.disabled = t === 'dark';
  mdDark.disabled = t === 'light';
}

function applyTheme(next: 'light' | 'dark'): void {
  theme = next;
  applyThemeStyles(theme);
  themeButton.textContent = theme === 'light' ? '🌙 다크' : '☀️ 라이트';
  localStorage.setItem('mdv.theme', theme);
}

// ---------------------------------------------------------------------------
// 토스트/상태 표시
// ---------------------------------------------------------------------------
function showLoading(text = '렌더링 중...'): void {
  loadingLabel.textContent = text;
  loading.hidden = false;
}

function hideLoading(): void {
  loading.hidden = true;
}

let toastTimer: number | undefined;
function showToast(message: string, ms = 2600): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, ms);
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 문서 렌더링
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 편집 모드 전환 / 저장
// ---------------------------------------------------------------------------
async function enterEditMode(): Promise<void> {
  if (!currentFile || editMode) return;
  editMode = true;
  const source = draftMarkdown ?? currentFile.content;
  content.hidden = true;
  editorEl.hidden = false;
  editButton.textContent = '👁 보기';
  editButton.title = '보기 모드로 전환 (Ctrl+E)';
  saveButton.hidden = false;
  try {
    editorHandle = await createEditor(editorEl, source, currentFile.dirUrl, () => setDirty(true));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`편집기를 열지 못했습니다: ${msg}`, 5000);
    await exitEditMode(false);
  }
}

async function exitEditMode(rerender = true): Promise<void> {
  if (!editMode) return;
  editMode = false;
  if (editorHandle) {
    draftMarkdown = editorHandle.getMarkdown();
    try { await editorHandle.destroy(); } catch { /* 파괴 실패는 무시 */ }
    editorHandle = null;
  }
  editorEl.hidden = true;
  editorEl.replaceChildren();
  content.hidden = false;
  editButton.textContent = '✏️ 편집';
  editButton.title = '편집 모드로 전환 (Ctrl+E)';
  saveButton.hidden = true;
  if (rerender && currentFile && draftMarkdown !== null) {
    renderDocument({ ...currentFile, content: draftMarkdown, reason: 'reload' }, { keepDraft: true });
  }
}

async function toggleEditMode(): Promise<void> {
  if (editMode) await exitEditMode();
  else await enterEditMode();
}

async function saveDocument(): Promise<boolean> {
  if (!currentFile) return false;
  const markdown = editMode && editorHandle ? editorHandle.getMarkdown() : draftMarkdown;
  if (markdown === null || markdown === undefined) {
    showToast('저장할 편집 내용이 없습니다.');
    return false;
  }
  const result = await mdv.saveFile(markdown);
  if (result.ok) {
    draftMarkdown = markdown;
    currentFile.content = markdown;
    setDirty(false);
    statusUpdated.textContent = `저장됨 ${formatTime(result.savedAt ?? Date.now())}`;
    showToast(`저장되었습니다 (${(result.encoding ?? 'utf-8').toUpperCase()})`);
    return true;
  }
  showToast(result.error ?? '저장에 실패했습니다.', 5000);
  return false;
}

/** Markdown 원문을 보기용 DOM(#content)에 렌더링 (렌더링/인쇄에서 공용) */
function renderIntoContent(markdown: string, dirUrl: string): void {
  try {
    const { fragment } = renderMarkdown(markdown, dirUrl);
    content.replaceChildren(fragment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    content.textContent = `문서를 표시하는 중 오류가 발생했습니다: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// 인쇄
//  - 지면 구성(툴바 숨김/흰 배경/페이지 나눔)은 styles.css의 @media print 담당
//  - 편집 중에도 화면에 보이는 내용 그대로 인쇄되도록 편집본을 보기용 DOM에 반영
// ---------------------------------------------------------------------------
/** 인쇄 전 이미지 로드 대기 — 아직 로드 중인 이미지는 빈 자리로 인쇄되므로 */
function waitForImages(root: HTMLElement, timeoutMs = 3000): Promise<void> {
  const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  const loaded = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true }); // 실패한 이미지도 더 기다리지 않는다
        }),
    ),
  ).then(() => undefined);
  // 네트워크 이미지 등으로 무한정 대기하지 않도록 타임아웃
  return Promise.race([loaded, new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))]);
}

async function printDocument(): Promise<void> {
  if (!currentFile) {
    showToast('인쇄할 문서가 없습니다. 먼저 파일을 여세요.');
    return;
  }
  if (printing) return; // 인쇄 대화상자가 이미 떠 있음
  printing = true;
  // 다크 테마의 코드 하이라이팅은 흰 지면에서 대비가 낮아 읽기 어려우므로
  // 인쇄하는 동안만 라이트 스타일시트로 바꿨다가 되돌린다 (설정은 유지)
  const wasDark = theme === 'dark';
  try {
    if (editMode && editorHandle) {
      draftMarkdown = editorHandle.getMarkdown();
      renderIntoContent(draftMarkdown, currentFile.dirUrl);
    }
    if (wasDark) applyThemeStyles('light');
    await waitForImages(content);
    const result = await mdv.print();
    if (result.ok) showToast('인쇄를 시작했습니다.');
    else if (!result.canceled) showToast(result.error ?? '인쇄에 실패했습니다.', 5000);
  } finally {
    if (wasDark) applyThemeStyles('dark');
    printing = false;
  }
}

// ---------------------------------------------------------------------------
// 내보내기 (F-1101)
//  - 인쇄와 동일한 정책: 편집 중이면 편집 중인 내용을 기준으로 내보낸다
//  - 실제 파일 생성은 main이 담당한다 (renderer는 sandbox라 파일을 쓸 수 없다)
// ---------------------------------------------------------------------------
/** 내보낼 본문 HTML — 앱 전용 UI(복사 버튼)를 제거한 사본에서 뽑는다 */
function buildExportBody(): string {
  const clone = content.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.copy-btn').forEach((btn) => btn.remove());
  return clone.innerHTML;
}

/** 문서 제목: 첫 h1이 있으면 그것을, 없으면 확장자를 뗀 파일명을 쓴다 */
function documentTitle(): string {
  const heading = content.querySelector('h1')?.textContent?.trim();
  if (heading) return heading;
  const fileName = currentFile?.fileName ?? 'document';
  return fileName.replace(/\.(md|markdown|txt)$/i, '');
}

// ---------------------------------------------------------------------------
// 가져오기 (F-1201)
//  - main이 ZIP을 풀어 넘긴 XML을 여기서 DOMParser로 해석한다.
//  - 결과는 저장되지 않은 문서로 열고, 사용자가 확인한 뒤 저장하게 한다 (F-1202).
// ---------------------------------------------------------------------------
async function importDocument(format: ImportFormat): Promise<void> {
  if (importing) return; // 파일 선택 대화상자가 이미 떠 있음
  importing = true;
  try {
    const result = await mdv.importDocument(format);
    if (!result.ok || !result.payload) {
      if (!result.canceled) showToast(result.error ?? '가져오기에 실패했습니다.', 5000);
      return;
    }
    showLoading('가져오는 중...');
    const payload = result.payload;
    const fileName = payload.filePath.replace(/^.*[\\/]/, '');
    const title = fileName.replace(/\.docx$/i, '');
    // 무거운 파싱 전에 로딩 표시가 화면에 그려지도록 한 박자 넘긴다
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const markdown = docModelToMarkdown(docxToDocModel(payload, title));

    // 원본 폴더를 기준으로 두면 상대 경로 이미지가 자연스럽다.
    // 이미지는 data URI로 들어 있으므로 dirUrl은 화면 표시에만 쓰인다.
    const dirUrl = `file:///${payload.filePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '')}/`;
    renderDocument({
      filePath: payload.filePath,
      fileName: `${title}.md`,
      dirUrl,
      content: markdown,
      encoding: 'utf-8',
      reason: 'open',
      updatedAt: Date.now(),
    });
    // 아직 .md로 저장되지 않은 상태임을 알린다
    setDirty(true);
    showToast(`${fileName}을(를) Markdown으로 가져왔습니다. 확인 후 저장하세요.`, 5000);
  } catch (err) {
    showToast(err instanceof Error ? err.message : '가져오기에 실패했습니다.', 5000);
  } finally {
    hideLoading();
    importing = false;
  }
}

async function exportDocument(format: ExportFormat): Promise<void> {
  if (!currentFile) {
    showToast('내보낼 문서가 없습니다. 먼저 파일을 여세요.');
    return;
  }
  if (exporting) return; // 저장 대화상자가 이미 떠 있음
  exporting = true;
  showLoading('내보내는 중...');
  // DocModel은 코드 강조 색을 계산된 스타일에서 읽으므로 라이트 테마에서 만들어야 한다
  // (인쇄와 같은 정책: 배포용 문서는 흰 배경 기준)
  const wasDark = theme === 'dark';
  try {
    if (editMode && editorHandle) {
      draftMarkdown = editorHandle.getMarkdown();
      renderIntoContent(draftMarkdown, currentFile.dirUrl);
    }
    await waitForImages(content); // 로드되지 않은 이미지는 크기를 알 수 없고 임베드도 되지 않는다
    if (wasDark) applyThemeStyles('light');
    // DOCX/HWPX는 같은 중간 모델(DocModel)을 쓰고, HTML만 본문 HTML을 그대로 보낸다
    const request =
      format === 'html'
        ? { format, title: documentTitle(), html: buildExportBody() }
        : { format, title: documentTitle(), doc: buildDocModel(content, documentTitle()) };
    const result = await mdv.exportDocument(request);
    if (result.ok) showToast(`내보냈습니다: ${result.filePath}`, 4000);
    else if (!result.canceled) showToast(result.error ?? '내보내기에 실패했습니다.', 5000);
  } finally {
    if (wasDark) applyThemeStyles('dark');
    hideLoading();
    exporting = false;
  }
}

function renderDocument(payload: FileOpenedPayload, opts?: { keepDraft?: boolean }): void {
  currentFile = payload;
  if (!opts?.keepDraft) draftMarkdown = null;
  showLoading(); // 렌더링 중 표시 (NF-003)

  // 로딩 오버레이가 화면에 그려진 뒤 파싱 시작 (큰 문서 대비)
  window.setTimeout(() => {
    const keepScroll = payload.reason !== 'open';
    const prevScrollTop = viewport.scrollTop;

    renderIntoContent(payload.content, payload.dirUrl);

    emptyState.hidden = true;
    content.hidden = false;
    hideLoading();

    updateTitle();
    fileNameLabel.title = payload.filePath;
    statusEncoding.textContent = payload.encoding.toUpperCase();
    statusUpdated.textContent = `업데이트 ${formatTime(payload.updatedAt)}`;

    viewport.scrollTop = keepScroll ? prevScrollTop : 0;
    if (payload.reason === 'watch') showToast('파일 변경이 감지되어 새로고침했습니다.');
  }, 15);
}

// ---------------------------------------------------------------------------
// 최근 파일 목록 (시작 화면)
// ---------------------------------------------------------------------------
async function refreshRecentList(): Promise<void> {
  try {
    const files = await mdv.getRecentFiles();
    recentBox.hidden = files.length === 0;
    recentList.replaceChildren(
      ...files.map((p) => {
        const li = document.createElement('li');
        li.textContent = p;
        li.title = p;
        li.addEventListener('click', () => void mdv.openPath(p));
        return li;
      }),
    );
  } catch {
    /* 최근 파일 표시는 부가 기능 */
  }
}

// ---------------------------------------------------------------------------
// 이벤트 바인딩
// ---------------------------------------------------------------------------
$('btn-open').addEventListener('click', () => void mdv.openFileDialog());
$('btn-refresh').addEventListener('click', () => void mdv.reload());
editButton.addEventListener('click', () => void toggleEditMode());
saveButton.addEventListener('click', () => void saveDocument());
printButton.addEventListener('click', () => void printDocument());
$('btn-zoom-in').addEventListener('click', () => applyZoom(zoom + ZOOM_STEP));
$('btn-zoom-out').addEventListener('click', () => applyZoom(zoom - ZOOM_STEP));
themeButton.addEventListener('click', () => applyTheme(theme === 'light' ? 'dark' : 'light'));

encodingSelect.addEventListener('change', () => {
  if (currentFile) {
    void mdv.reload(encodingSelect.value as EncodingChoice);
  }
});

// 링크 클릭: 외부 링크는 기본 브라우저, 로컬 .md는 뷰어에서 열기 (NF-202)
content.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;

  const copyBtn = target.closest('.copy-btn');
  if (copyBtn) {
    const code = copyBtn.parentElement?.querySelector('pre code');
    if (code) {
      navigator.clipboard.writeText(code.textContent ?? '').then(
        () => showToast('코드가 클립보드에 복사되었습니다.'),
        () => showToast('복사에 실패했습니다.'),
      );
    }
    return;
  }

  const anchor = target.closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  ev.preventDefault();

  if (/^https?:|^mailto:/i.test(href)) {
    void mdv.openExternal(href);
    return;
  }
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (href.startsWith('file:')) {
    if (/\.(md|markdown|txt)([?#]|$)/i.test(href)) {
      void mdv.openPath(fileUrlToPath(href));
    } else {
      showToast('Markdown(.md/.markdown/.txt) 파일만 열 수 있습니다.');
    }
  }
});

function fileUrlToPath(fileUrl: string): string {
  const u = new URL(fileUrl);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // /C:/... -> C:/...
  return p.replace(/\//g, '\\');
}

// 드래그 앤 드롭으로 파일 열기
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  const file = ev.dataTransfer?.files?.[0];
  if (!file) return;
  const p = mdv.getPathForFile(file);
  if (p) void mdv.openPath(p);
});

// 키보드 단축키 보강 (메뉴 액셀러레이터 + 숫자패드/Ctrl+R/Ctrl+휠)
window.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); void mdv.reload(); }
    else if (ev.key === '+' || ev.code === 'NumpadAdd') { ev.preventDefault(); applyZoom(zoom + ZOOM_STEP); }
    else if (ev.key === '-' || ev.code === 'NumpadSubtract') { ev.preventDefault(); applyZoom(zoom - ZOOM_STEP); }
    else if (ev.code === 'Numpad0') { ev.preventDefault(); applyZoom(100); }
  }
});

window.addEventListener('wheel', (ev) => {
  if (ev.ctrlKey) {
    ev.preventDefault();
    applyZoom(zoom + (ev.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// main 프로세스 이벤트
// ---------------------------------------------------------------------------
mdv.onFileOpened((payload) => {
  // 편집 중에는 자동 새로고침/수동 새로고침으로 편집 내용을 덮어쓰지 않는다
  if ((editMode || dirty) && payload.reason !== 'open') {
    showToast(payload.reason === 'watch'
      ? '외부에서 파일이 변경되었지만 편집 중이라 새로고침하지 않았습니다.'
      : '편집 중에는 새로고침할 수 없습니다. 보기 모드로 전환한 뒤 다시 시도하세요.');
    return;
  }
  // 다른 파일 열기: 편집 상태 정리 (저장 여부는 main에서 이미 확인)
  if (payload.reason === 'open') {
    void exitEditMode(false);
    draftMarkdown = null;
    setDirty(false);
  }
  encodingSelect.value = normalizeEncodingChoice(payload.encoding);
  renderDocument(payload);
});

mdv.onFileError(({ message }) => {
  hideLoading();
  showToast(message, 5000);
});

mdv.onCommand((cmd) => {
  switch (cmd) {
    case 'zoom-in': applyZoom(zoom + ZOOM_STEP); break;
    case 'zoom-out': applyZoom(zoom - ZOOM_STEP); break;
    case 'zoom-reset': applyZoom(100); break;
    case 'theme-toggle': applyTheme(theme === 'light' ? 'dark' : 'light'); break;
    case 'edit-toggle': void toggleEditMode(); break;
    case 'save': void saveDocument(); break;
    case 'print': void printDocument(); break;
    case 'export-html': void exportDocument('html'); break;
    case 'export-docx': void exportDocument('docx'); break;
    case 'export-hwpx': void exportDocument('hwpx'); break;
    case 'import-docx': void importDocument('docx'); break;
    case 'save-close':
      void saveDocument().then((ok) => mdv.resolveClose(ok ? 'close' : 'cancel'));
      break;
  }
});

function normalizeEncodingChoice(encoding: string): string {
  if (encoding.startsWith('utf-8')) return 'utf-8';
  if (encoding === 'cp949' || encoding === 'euc-kr' || encoding === 'utf-16le') return encoding;
  return 'auto';
}

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
applyZoom(zoom);
applyTheme(theme);
void refreshRecentList();
