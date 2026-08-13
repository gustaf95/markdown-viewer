import { renderMarkdown } from './markdown';
import { createEditor, EditorHandle } from './editor';
import type { EncodingChoice, FileOpenedPayload, MdvApi } from '../common/types';

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

function applyTheme(next: 'light' | 'dark'): void {
  theme = next;
  document.body.dataset.theme = theme;
  const lightCss = document.getElementById('hljs-light') as HTMLLinkElement;
  const darkCss = document.getElementById('hljs-dark') as HTMLLinkElement;
  lightCss.disabled = theme === 'dark';
  darkCss.disabled = theme === 'light';
  const mdLight = document.getElementById('milkdown-light') as HTMLLinkElement;
  const mdDark = document.getElementById('milkdown-dark') as HTMLLinkElement;
  mdLight.disabled = theme === 'dark';
  mdDark.disabled = theme === 'light';
  themeButton.textContent = theme === 'light' ? '🌙 다크' : '☀️ 라이트';
  localStorage.setItem('mdv.theme', theme);
}

// ---------------------------------------------------------------------------
// 토스트/상태 표시
// ---------------------------------------------------------------------------
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

function renderDocument(payload: FileOpenedPayload, opts?: { keepDraft?: boolean }): void {
  currentFile = payload;
  if (!opts?.keepDraft) draftMarkdown = null;
  loading.hidden = false; // 렌더링 중 표시 (NF-003)

  // 로딩 오버레이가 화면에 그려진 뒤 파싱 시작 (큰 문서 대비)
  window.setTimeout(() => {
    const keepScroll = payload.reason !== 'open';
    const prevScrollTop = viewport.scrollTop;

    try {
      const { fragment } = renderMarkdown(payload.content, payload.dirUrl);
      content.replaceChildren(fragment);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      content.textContent = `문서를 표시하는 중 오류가 발생했습니다: ${msg}`;
    }

    emptyState.hidden = true;
    content.hidden = false;
    loading.hidden = true;

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
  loading.hidden = true;
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
