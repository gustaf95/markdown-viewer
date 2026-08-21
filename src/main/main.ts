import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as iconv from 'iconv-lite';
import { AppCommand, EncodingChoice, ExportRequest, ExportResult, FileOpenedPayload, ImportResult, PrintResult, SaveResult } from '../common/types';
import { buildExportedHtml } from './export-html';
import { buildDocx } from './export-docx';
import { buildHwpx } from './export-hwpx';
import { readDocx } from './import-docx';
import { readHwpx } from './import-hwpx';

const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.txt'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RECENT = 10;

let mainWindow: BrowserWindow | null = null;
let currentFilePath: string | null = null;
/** 사용자가 상태 표시줄에서 강제로 지정한 인코딩 (null이면 자동 감지) */
let encodingOverride: Exclude<EncodingChoice, 'auto'> | null = null;
let watchedFilePath: string | null = null;
/** 현재 파일을 읽을 때 실제 사용된 인코딩 — 저장 시 그대로 유지 */
let currentEncoding = 'utf-8';
/** 편집 모드에서 저장되지 않은 변경이 있는지 (renderer가 IPC로 갱신) */
let docDirty = false;
/** 닫기 확인 대화상자를 거친 뒤 실제로 창을 닫을 때 true */
let forceClose = false;
/** 자기 자신의 저장으로 인한 파일 변경을 감시에서 무시하기 위한 타임스탬프 */
let lastSelfSaveAt = 0;
/** 스모크 테스트에서 저장 대화상자 없이 내보낼 경로 (없으면 평소처럼 대화상자를 띄운다) */
const smokeExportPath = process.env.MDV_SMOKE_EXPORT ?? null;
/** 파일 선택 대화상자 없이 이 파일을 가져오는 스모크 테스트 훅 */
const smokeImportPath = process.env.MDV_SMOKE_IMPORT ?? null;

/** 내보내기 형식별 대화상자/확장자 정보 */
const EXPORT_FORMATS = {
  html: { label: 'HTML', ext: 'html', filter: 'HTML 문서' },
  docx: { label: 'DOCX', ext: 'docx', filter: 'Word 문서' },
  hwpx: { label: 'HWPX', ext: 'hwpx', filter: '한글 문서' },
} as const;

// ---------------------------------------------------------------------------
// 인코딩 처리 (F-006, F-205): BOM -> UTF-16 -> 엄격한 UTF-8 -> CP949 순으로 판별
// ---------------------------------------------------------------------------
function decodeBuffer(buf: Buffer, forced?: Exclude<EncodingChoice, 'auto'> | null): { text: string; encoding: string } {
  if (forced) {
    if (forced === 'utf-8') {
      let body = buf;
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) body = buf.subarray(3);
      return { text: body.toString('utf8'), encoding: 'utf-8' };
    }
    return { text: iconv.decode(buf, forced), encoding: forced };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (bom)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf, 'utf-16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf, 'utf-16be'), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'cp949'), encoding: 'cp949' };
  }
}

/** 저장 시 원래 인코딩 그대로 인코딩 (F-205: 편집해도 파일 인코딩이 바뀌지 않도록) */
function encodeText(text: string, encoding: string): Buffer {
  switch (encoding) {
    case 'utf-8 (bom)':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'cp949':
    case 'euc-kr':
      return iconv.encode(text, encoding);
    case 'utf-16le':
    case 'utf-16be':
      return iconv.encode(text, encoding, { addBOM: true });
    default:
      return Buffer.from(text, 'utf8');
  }
}

/**
 * 임시 파일에 먼저 쓴 뒤 교체한다 (F-1101).
 * 변환 도중 실패해도 반쪽짜리 결과물이 사용자의 파일을 덮어쓰지 않도록.
 */
async function writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, filePath); // Windows에서도 기존 파일을 덮어쓴다
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 최근 파일 (F-004)
// ---------------------------------------------------------------------------
function recentFilesPath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function loadRecentFiles(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(recentFilesPath(), 'utf8'));
    if (Array.isArray(list)) return list.filter((p) => typeof p === 'string');
  } catch {
    /* 첫 실행 또는 손상된 파일: 빈 목록으로 시작 */
  }
  return [];
}

function saveRecentFiles(list: string[]): void {
  try {
    fs.writeFileSync(recentFilesPath(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* 저장 실패는 치명적이지 않음 */
  }
}

function addRecentFile(filePath: string): void {
  const list = loadRecentFiles().filter((p) => p !== filePath);
  list.unshift(filePath);
  saveRecentFiles(list.slice(0, MAX_RECENT));
  rebuildMenu();
}

// ---------------------------------------------------------------------------
// 파일 열기 + 변경 감시 (F-001~F-006, F-901~F-903)
// ---------------------------------------------------------------------------
async function openFile(filePath: string, reason: FileOpenedPayload['reason']): Promise<void> {
  const win = mainWindow;
  if (!win) return;
  // 편집 중 저장되지 않은 변경이 있으면 다른 파일 열기 전에 확인 (자동 새로고침 제외)
  if (reason === 'open' && docDirty && filePath !== currentFilePath) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: '저장되지 않은 변경',
      message: '저장하지 않은 변경 내용이 있습니다.',
      detail: '다른 파일을 열면 변경 내용이 사라집니다. 먼저 Ctrl+S로 저장할 수 있습니다.',
      buttons: ['저장하지 않고 열기', '취소'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 1) return;
    docDirty = false;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      win.webContents.send('file:error', { message: `파일이 너무 큽니다 (${(stat.size / 1024 / 1024).toFixed(1)}MB). 50MB 이하 파일만 열 수 있습니다.` });
      return;
    }
    const buf = await fs.promises.readFile(filePath);
    if (reason === 'open') encodingOverride = null; // 새 파일은 자동 감지부터
    const { text, encoding } = decodeBuffer(buf, encodingOverride);

    currentEncoding = encoding;
    currentFilePath = filePath;
    watchFile(filePath);
    if (reason === 'open') addRecentFile(filePath);

    const payload: FileOpenedPayload = {
      filePath,
      fileName: path.basename(filePath),
      dirUrl: pathToFileURL(path.dirname(filePath)).href,
      content: text,
      encoding,
      reason,
      updatedAt: Date.now(),
    };
    win.webContents.send('file:opened', payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    win.webContents.send('file:error', { message: `파일을 열 수 없습니다: ${filePath}\n(${msg})` });
  }
}

/** 외부 편집기 저장 감지: 에디터의 원자적 저장(rename)에도 안전하도록 폴링 방식 사용 */
function watchFile(filePath: string): void {
  if (watchedFilePath === filePath) return;
  if (watchedFilePath) fs.unwatchFile(watchedFilePath);
  watchedFilePath = filePath;
  fs.watchFile(filePath, { interval: 800 }, (curr, prev) => {
    if (Date.now() - lastSelfSaveAt < 2000) return; // 자기 저장으로 인한 변경은 무시
    if (curr.mtimeMs !== prev.mtimeMs && curr.mtimeMs !== 0) {
      void openFile(filePath, 'watch');
    }
  });
}

async function showOpenDialog(): Promise<void> {
  const win = mainWindow;
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    title: 'Markdown 파일 열기',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    await openFile(result.filePaths[0], 'open');
  }
}

function sendCommand(cmd: AppCommand): void {
  mainWindow?.webContents.send('app:command', cmd);
}

// ---------------------------------------------------------------------------
// 메뉴 (한국어 UI, 권장 단축키 반영)
// ---------------------------------------------------------------------------
function rebuildMenu(): void {
  const recent = loadRecentFiles().filter((p) => fs.existsSync(p));
  const recentItems: MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((p) => ({ label: p, click: () => void openFile(p, 'open') }))
      : [{ label: '(없음)', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        { label: '열기...', accelerator: 'CmdOrCtrl+O', click: () => void showOpenDialog() },
        { label: '최근 파일', submenu: recentItems },
        { type: 'separator' },
        {
          label: '새로고침',
          accelerator: 'F5',
          click: () => { if (currentFilePath) void openFile(currentFilePath, 'reload'); },
        },
        { type: 'separator' },
        { label: '편집 모드 전환', accelerator: 'CmdOrCtrl+E', click: () => sendCommand('edit-toggle') },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { type: 'separator' },
        { label: '인쇄...', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('print') },
        {
          label: '가져오기',
          submenu: [
            { label: 'DOCX (Word)...', click: () => sendCommand('import-docx') },
            { label: 'HWPX (한글)...', click: () => sendCommand('import-hwpx') },
          ],
        },
        {
          label: '내보내기',
          submenu: [
            {
              label: 'HTML...',
              accelerator: 'CmdOrCtrl+Shift+H',
              enabled: currentFilePath !== null, // 문서가 없으면 비활성화
              click: () => sendCommand('export-html'),
            },
            {
              label: 'DOCX (Word)...',
              accelerator: 'CmdOrCtrl+Shift+D',
              enabled: currentFilePath !== null,
              click: () => sendCommand('export-docx'),
            },
            {
              label: 'HWPX (한글)...',
              accelerator: 'CmdOrCtrl+Shift+W',
              enabled: currentFilePath !== null,
              click: () => sendCommand('export-hwpx'),
            },
          ],
        },
        { type: 'separator' },
        { label: '종료', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '확대', accelerator: 'CmdOrCtrl+=', click: () => sendCommand('zoom-in') },
        { label: '축소', accelerator: 'CmdOrCtrl+-', click: () => sendCommand('zoom-out') },
        { label: '기본 크기', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('zoom-reset') },
        { type: 'separator' },
        { label: '다크/라이트 모드 전환', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendCommand('theme-toggle') },
        { type: 'separator' },
        { label: '개발자 도구', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: 'Markdown Viewer 정보',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'Markdown Viewer 정보',
              message: `Markdown Viewer ${app.getVersion()}`,
              detail: 'Windows용 한글 친화 Markdown 뷰어\nElectron + TypeScript + markdown-it + KaTeX + highlight.js',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 창 생성 (NF-204 보안 설정)
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 480,
    minHeight: 360,
    title: 'Markdown Viewer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 렌더러 내 네비게이션 차단: 외부 링크는 기본 브라우저로 (NF-202)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // 저장되지 않은 변경이 있으면 닫기 전에 확인
  mainWindow.on('close', (event) => {
    if (forceClose || !docDirty || !mainWindow) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '저장되지 않은 변경',
      message: '저장하지 않은 변경 내용이 있습니다. 저장할까요?',
      buttons: ['저장 후 닫기', '저장하지 않고 닫기', '취소'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) {
      // renderer가 저장을 마친 뒤 app:resolve-close('close')를 보내면 실제로 닫는다
      mainWindow.webContents.send('app:command', 'save-close' satisfies AppCommand);
    } else if (choice === 1) {
      forceClose = true;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    // 명령행 인자로 전달된 파일 열기 (파일 연결/드래그 실행 지원)
    const argFile = findFileInArgv(process.argv);
    if (argFile) void openFile(argFile, 'open');
    setupSmokeTestIfRequested();
  });
}

function findFileInArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    try {
      const resolved = path.resolve(arg);
      if (SUPPORTED_EXTENSIONS.includes(path.extname(resolved).toLowerCase()) && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      /* 잘못된 인자는 무시 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 스모크 테스트 모드: MDV_SMOKE_FILE 환경변수로 파일을 열고 스크린샷 저장 후 종료
// ---------------------------------------------------------------------------
function setupSmokeTestIfRequested(): void {
  const smokeFile = process.env.MDV_SMOKE_FILE;
  const smokeOut = process.env.MDV_SMOKE_OUT;
  if (!smokeFile || !smokeOut || !mainWindow) return;
  const win = mainWindow;
  win.webContents.on('console-message', (...args: unknown[]) => {
    const ev = args[0] as { level?: unknown; message?: unknown };
    if (typeof ev === 'object' && ev !== null && 'message' in ev) {
      console.log(`[renderer:${String(ev.level)}] ${String(ev.message)}`);
    } else {
      console.log(`[renderer:${String(args[1])}] ${String(args[2])}`);
    }
  });
  void openFile(path.resolve(smokeFile), 'open');
  if (process.env.MDV_SMOKE_THEME === 'dark') {
    setTimeout(() => sendCommand('theme-toggle'), 1200);
  }
  let captureDelay = 3000;
  if (smokeExportPath) {
    // MDV_SMOKE_EXPORT_FORMAT=docx|hwpx 로 형식을 고를 수 있다 (기본 html)
    const chosen = process.env.MDV_SMOKE_EXPORT_FORMAT;
    const format: AppCommand =
      chosen === 'docx' ? 'export-docx' : chosen === 'hwpx' ? 'export-hwpx' : 'export-html';
    setTimeout(() => sendCommand(format), 2000);
    captureDelay = 5000;
  }
  if (smokeImportPath) {
    const command: AppCommand = /\.hwpx$/i.test(smokeImportPath) ? 'import-hwpx' : 'import-docx';
    setTimeout(() => sendCommand(command), 2000);
    captureDelay = 5500;
  }
  if (process.env.MDV_SMOKE_EDIT === '1') {
    setTimeout(() => sendCommand('edit-toggle'), 1500);
    captureDelay = 4500;
    if (process.env.MDV_SMOKE_SAVE === '1') {
      setTimeout(() => sendCommand('save'), 3200);
      captureDelay = 5500;
    }
  }
  setTimeout(async () => {
    try {
      win.show();
      win.focus();
      for (let attempt = 0; attempt < 10; attempt++) {
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        if (png.length > 1000) {
          fs.writeFileSync(smokeOut, png);
          console.log(`[smoke] screenshot saved (${png.length} bytes, attempt ${attempt + 1}): ${smokeOut}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err) {
      console.error('[smoke] capture failed', err);
    }
    app.exit(0);
  }, captureDelay);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('dialog:open', () => showOpenDialog());
  ipcMain.handle('file:openPath', (_e, filePath: unknown) => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    if (!SUPPORTED_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) return;
    return openFile(resolved, 'open');
  });
  ipcMain.handle('file:reload', (_e, encoding: unknown) => {
    if (encoding === 'auto') {
      encodingOverride = null;
    } else if (encoding === 'utf-8' || encoding === 'cp949' || encoding === 'euc-kr' || encoding === 'utf-16le') {
      encodingOverride = encoding;
    }
    if (currentFilePath) return openFile(currentFilePath, 'reload');
  });
  ipcMain.handle('recent:get', () => loadRecentFiles().filter((p) => fs.existsSync(p)));
  ipcMain.handle('file:save', async (_e, content: unknown): Promise<SaveResult> => {
    if (typeof content !== 'string') return { ok: false, error: '잘못된 저장 요청입니다.' };
    if (!currentFilePath) return { ok: false, error: '열려 있는 파일이 없습니다.' };
    try {
      const buf = encodeText(content, currentEncoding);
      lastSelfSaveAt = Date.now();
      await fs.promises.writeFile(currentFilePath, buf);
      lastSelfSaveAt = Date.now();
      docDirty = false;
      return { ok: true, savedAt: Date.now(), encoding: currentEncoding };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `저장에 실패했습니다: ${msg}` };
    }
  });
  // 인쇄 (F-1001): 렌더러가 인쇄용 DOM을 준비한 뒤 호출한다.
  // 실제 페이지 구성은 styles.css의 @media print 규칙이 담당한다.
  ipcMain.handle('file:print', async (): Promise<PrintResult> => {
    const win = mainWindow;
    if (!win) return { ok: false, error: '인쇄할 창을 찾을 수 없습니다.' };
    try {
      return await new Promise<PrintResult>((resolve) => {
        win.webContents.print(
          { silent: false, printBackground: true, color: true },
          (success, failureReason) => {
            if (success) return resolve({ ok: true });
            // 사용자가 대화상자를 닫은 경우는 오류가 아니다
            if (/cancel/i.test(failureReason ?? '')) return resolve({ ok: false, canceled: true });
            resolve({ ok: false, error: failureReason || '인쇄에 실패했습니다.' });
          },
        );
      });
    } catch (err) {
      // 사용 가능한 프린터가 없으면 print()가 즉시 예외를 던진다
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `인쇄를 시작할 수 없습니다: ${msg}` };
    }
  });
  // 가져오기 (F-1201): main은 ZIP을 풀어 XML만 꺼내고, 해석은 renderer가 한다.
  ipcMain.handle('file:import', async (_e, format: unknown): Promise<ImportResult> => {
    const win = mainWindow;
    if (!win) return { ok: false, error: '창을 찾을 수 없습니다.' };
    if (format !== 'docx' && format !== 'hwpx') return { ok: false, error: '지원하지 않는 형식입니다.' };
    const spec = format === 'docx'
      ? { title: 'DOCX 가져오기', name: 'Word 문서', ext: 'docx' }
      : { title: 'HWPX 가져오기', name: '한글 문서', ext: 'hwpx' };
    let filePath = smokeImportPath;
    if (!filePath) {
      const result = await dialog.showOpenDialog(win, {
        title: spec.title,
        properties: ['openFile'],
        filters: [{ name: spec.name, extensions: [spec.ext] }],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      filePath = result.filePaths[0];
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) return { ok: false, error: '파일이 너무 큽니다 (50MB 초과).' };
      // 원본은 읽기만 한다 (F-1209)
      return format === 'docx'
        ? { ok: true, payload: { format, filePath, ...readDocx(filePath) } }
        : { ok: true, payload: { format, filePath, ...readHwpx(filePath) } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `가져오기에 실패했습니다: ${msg}` };
    }
  });
  // 내보내기 (F-1101, F-1102): 렌더러가 보기용 DOM에서 뽑은 내용을 파일로 저장한다.
  ipcMain.handle('file:export', async (_e, request: unknown): Promise<ExportResult> => {
    const win = mainWindow;
    if (!win) return { ok: false, error: '내보낼 창을 찾을 수 없습니다.' };
    const req = request as Partial<ExportRequest> | null;
    if (!req || !(req.format === 'html' || req.format === 'docx' || req.format === 'hwpx')) {
      return { ok: false, error: '잘못된 내보내기 요청입니다.' };
    }
    if (req.format === 'html' && typeof req.html !== 'string') {
      return { ok: false, error: '내보낼 본문을 받지 못했습니다.' };
    }
    if (req.format !== 'html' && (!req.doc || !Array.isArray(req.doc.blocks))) {
      return { ok: false, error: '내보낼 본문을 받지 못했습니다.' };
    }
    if (!currentFilePath) return { ok: false, error: '열려 있는 파일이 없습니다.' };

    const baseName = path.basename(currentFilePath, path.extname(currentFilePath));
    const spec = EXPORT_FORMATS[req.format];
    let targetPath = smokeExportPath;
    if (!targetPath) {
      const result = await dialog.showSaveDialog(win, {
        title: `${spec.label}로 내보내기`,
        // 기본 저장 위치는 원본 문서와 같은 폴더
        defaultPath: path.join(path.dirname(currentFilePath), `${baseName}.${spec.ext}`),
        filters: [{ name: spec.filter, extensions: [spec.ext] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      targetPath = result.filePath;
    }

    try {
      const title = typeof req.title === 'string' && req.title.trim() ? req.title.trim() : baseName;
      const doc = { ...req.doc!, title };
      const data =
        req.format === 'html'
          ? Buffer.from(buildExportedHtml(req.html ?? '', title), 'utf8')
          : req.format === 'docx'
            ? await buildDocx(doc)
            : buildHwpx(doc);
      await writeFileAtomic(targetPath, data);
      return { ok: true, filePath: targetPath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `내보내기에 실패했습니다: ${msg}` };
    }
  });
  ipcMain.on('doc:dirty', (_e, dirty: unknown) => {
    docDirty = dirty === true;
  });
  ipcMain.on('app:resolve-close', (_e, action: unknown) => {
    if (action === 'close' && mainWindow) {
      forceClose = true;
      mainWindow.close();
    }
  });
  ipcMain.handle('shell:openExternal', (_e, url: unknown) => {
    if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) {
      return shell.openExternal(url);
    }
  });
}

// ---------------------------------------------------------------------------
// 앱 라이프사이클 (단일 인스턴스: 두 번째 실행의 파일 인자를 기존 창에서 열기)
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const argFile = findFileInArgv(argv);
      if (argFile) void openFile(argFile, 'open');
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    rebuildMenu();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
