# Markdown Viewer for Windows

Windows용 한글 친화 Markdown 뷰어입니다. 요구사항 정의서는 [doc/README.md](doc/README.md)를 참고하세요.

- **GitHub**: <https://github.com/gustaf95/markdown-viewer> (private)
- Git 저장소는 로컬 빌드 폴더(`C:\Users\gusta\c_works\markdown_viewer`)에 있습니다. Google Drive(H:) 쪽에는 `.git`을 두지 않습니다 (가상 드라이브에서 저장소 손상 위험).

- **기술 스택**: Electron + TypeScript + markdown-it + KaTeX + highlight.js
- **보안**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, preload로 제한된 IPC API만 노출, DOMPurify로 HTML sanitize, CSP 적용
- **한글 지원**: UTF-8 / UTF-8 BOM / UTF-16 / CP949(EUC-KR) 자동 감지 + 수동 인코딩 선택

## 주요 기능

| 기능 | 설명 |
|---|---|
| 파일 열기 | `Ctrl+O`, 툴바 버튼, 드래그 앤 드롭, 최근 파일 목록, 명령행 인자 |
| Markdown 렌더링 | GFM(표, 취소선, 자동 링크), 체크박스 목록, 제한된 HTML(sanitize 후) |
| 수식 | KaTeX 기반, `$...$` / `$$...$$` 와 LaTeX 표기 `\(...\)` / `\[...\]` 모두 지원, 오류 시 원문 표시 (오프라인 동작) |
| 코드 하이라이팅 | highlight.js (언어 지정 fenced code block), 복사 버튼, 가로 스크롤 |
| 인코딩 | UTF-8 → CP949 순 자동 감지, 상태 표시줄에서 수동 선택 후 다시 열기 |
| 로컬 이미지 | 문서 위치 기준 상대 경로 해석, 누락 시 대체 텍스트 표시 |
| 테마 / 배율 | 라이트·다크 모드(`Ctrl+Shift+T`), 글자 확대/축소(`Ctrl+=/-/0`, `Ctrl+휠`), 설정 저장 |
| 자동 새로고침 | 외부 편집기의 저장을 감지해 자동 재렌더링 (스크롤 위치 유지) |

## 개발 환경 준비

1. [Node.js LTS](https://nodejs.org/) 설치 (이 프로젝트는 v24 LTS로 개발/테스트됨)
2. 의존성 설치:

```bash
npm install
```

> 참고: 이 저장소가 Google Drive 동기화 폴더(H:) 안에 있으면 `npm install`과 빌드가 느릴 수 있습니다. 문제가 생기면 로컬 디스크(C:)로 옮겨서 작업하는 것을 권장합니다.

## 실행 방법

가장 간단한 방법 (Node.js PATH 설정 불필요):

- **일반 사용**: `release\MarkdownViewer-0.1.0-portable.exe` 더블클릭 (또는 Setup exe로 설치)
- **개발 모드**: 프로젝트 루트의 `run-dev.cmd` 더블클릭 — Node portable을 PATH에 추가하고 빌드 후 실행

터미널에서 직접 실행하려면 (로컬 빌드 폴더에서, node-lts가 PATH에 있어야 함):

```bash
npm start
```

`npm start`는 내부적으로 다음을 수행합니다.

1. `npm run build:main` — main/preload TypeScript 컴파일 (`dist/main/`)
2. `npm run build:renderer` — renderer를 esbuild로 번들 (`dist/renderer/renderer.js`)
3. `npm run build:assets` — index.html, styles.css, KaTeX/highlight.js CSS·폰트 복사
4. `electron .` 실행

특정 파일을 바로 열려면:

```bash
npx electron . test-docs/mixed.md
```

## 테스트 방법

1. `npm run make:testdocs` 로 CP949 인코딩 테스트 문서를 생성합니다 (최초 1회).
2. `npm start` 후 `test-docs/` 아래 문서를 열어 다음을 확인합니다.

| 문서 | 확인 내용 |
|---|---|
| `korean.md` | 한글 제목/본문/목록/표/체크박스/인용문 |
| `math.md` | 인라인·블록 수식, 행렬, 잘못된 수식이 있어도 앱이 죽지 않는지 |
| `code.md` | Python/JS/TS/Bash/C++/JSON 하이라이팅, 복사 버튼, 가로 스크롤 |
| `table.md` | 정렬 표, 긴 표 가로 스크롤, 수식 포함 표 |
| `image-test.md` | 상대 경로 이미지, 한글 파일명 이미지, 누락 이미지 대체 텍스트 |
| `mixed.md` | 한글+수식+코드+표+이미지 종합 |
| `encoding-cp949.md` | CP949 자동 감지 (상태 표시줄에 CP949 표시) |

추가 확인 사항:

- 툴바·메뉴에서 테마 전환, 확대/축소가 동작하고 앱 재시작 후에도 유지되는지
- 외부 링크 클릭 시 기본 브라우저로 열리는지
- 문서를 연 상태에서 외부 편집기로 수정·저장하면 자동으로 다시 렌더링되는지
- 타입 검사: `npm run typecheck`

## 단축키

| 기능 | 단축키 |
|---|---|
| 파일 열기 | `Ctrl+O` |
| 새로고침 | `F5` 또는 `Ctrl+R` |
| 확대 / 축소 / 기본 크기 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (또는 `Ctrl+휠`) |
| 다크/라이트 모드 전환 | `Ctrl+Shift+T` |
| 종료 | `Ctrl+Q` |

## Windows용 exe 패키징

로컬 빌드 폴더(`C:\Users\gusta\c_works\markdown_viewer`)에서:

```bash
npm run dist
```

- electron-builder가 `release/` 폴더에 다음을 생성합니다 (모두 x64, 빌드 확인 완료):
  - `Markdown Viewer Setup 0.1.0.exe` — NSIS 설치 파일 (약 80MB)
  - `MarkdownViewer-0.1.0-portable.exe` — 무설치 포터블 실행 파일 (약 79MB)
- `.md` / `.markdown` 파일 연결(더블클릭으로 열기)이 설치 시 등록됩니다.
- 아이콘: `assets/icon.ico` (`scripts/make-icon.js`로 재생성 가능)
- 코드 서명은 하지 않으므로 처음 실행 시 SmartScreen 경고가 나올 수 있습니다 ("추가 정보 → 실행"으로 진행).

### 패키징 문제 해결

**`Cannot create symbolic link ... libcrypto.dylib` 오류로 실패하는 경우**:
electron-builder가 받는 winCodeSign 아카이브의 macOS 심볼릭 링크를 Windows에서 만들지 못해 생기는 알려진 문제입니다.
해결 방법 중 하나를 사용하세요.

1. (설정 변경 없이) 캐시를 수동으로 채우기 — 이 프로젝트에서 사용한 방법:

```bash
curl -L -o "%TEMP%\winCodeSign-2.6.0.7z" https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
node_modules\7zip-bin\win\x64\7za.exe x -y -o"%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0" -xr!darwin "%TEMP%\winCodeSign-2.6.0.7z"
```

2. 또는 Windows 설정에서 **개발자 모드**를 켜면 심볼릭 링크 생성이 허용되어 그대로 동작합니다.

## 프로젝트 구조

```text
markdown_viewer/
├─ package.json
├─ tsconfig.json            # 공통 타입 검사 설정
├─ tsconfig.main.json       # main/preload 컴파일 설정
├─ electron-builder.yml     # Windows x64 패키징 설정
├─ doc/README.md            # 요구사항 정의서
├─ scripts/
│  ├─ copy-assets.js        # 렌더러 정적 자산 복사
│  ├─ make-icon.js          # PNG -> ICO 변환
│  └─ make-test-docs.js     # CP949 테스트 문서 생성
├─ src/
│  ├─ main/
│  │  ├─ main.ts            # 창 생성, 메뉴, 파일 열기/감시, 인코딩 감지, IPC
│  │  └─ preload.ts         # contextBridge로 제한된 API 노출
│  ├─ renderer/
│  │  ├─ index.html         # CSP 포함 기본 레이아웃
│  │  ├─ renderer.ts        # UI 로직 (테마/배율/링크/드롭/복사)
│  │  ├─ markdown.ts        # markdown-it + KaTeX + highlight.js + DOMPurify
│  │  └─ styles.css         # 한글 친화 스타일, 라이트/다크 테마
│  └─ common/types.ts       # main <-> renderer 공유 타입
├─ assets/                  # 앱 아이콘
└─ test-docs/               # 테스트 문서 모음
```

## 구현 상태

- [x] 1. Electron + TypeScript 프로젝트 초기화
- [x] 2. 보안 설정 (nodeIntegration:false, contextIsolation:true, preload, sandbox, CSP, sanitize)
- [x] 3. 파일 열기 (대화상자, 최근 파일, 드래그 앤 드롭, 명령행 인자)
- [x] 4. markdown-it 기반 렌더링 (GFM 표, 체크박스, 취소선, 자동 링크)
- [x] 5. KaTeX 수식 렌더링 (오프라인 번들)
- [x] 6. highlight.js 코드 하이라이팅 + 복사 버튼
- [x] 7. UTF-8/CP949 인코딩 자동 감지 + 수동 선택
- [x] 8. 로컬 이미지 상대 경로 표시 + 누락 대체 텍스트
- [x] 9. 라이트/다크 모드, 확대/축소, 설정 저장
- [x] 10. electron-builder Windows x64 패키징 (NSIS 설치 파일 + 포터블 exe 생성 및 실행 확인 완료)
