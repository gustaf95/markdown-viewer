import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as iconv from 'iconv-lite';
import { AppCommand, EncodingChoice, FileOpenedPayload } from '../common/types';

const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.txt'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RECENT = 10;

let mainWindow: BrowserWindow | null = null;
let currentFilePath: string | null = null;
/** 사용자가 상태 표시줄에서 강제로 지정한 인코딩 (null이면 자동 감지) */
let encodingOverride: Exclude<EncodingChoice, 'auto'> | null = null;
let watchedFilePath: string | null = null;

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
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      win.webContents.send('file:error', { message: `파일이 너무 큽니다 (${(stat.size / 1024 / 1024).toFixed(1)}MB). 50MB 이하 파일만 열 수 있습니다.` });
      return;
    }
    const buf = await fs.promises.readFile(filePath);
    if (reason === 'open') encodingOverride = null; // 새 파일은 자동 감지부터
    const { text, encoding } = decodeBuffer(buf, encodingOverride);

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
  }, 3000);
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
