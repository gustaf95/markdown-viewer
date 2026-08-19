# Markdown Viewer — 구현 예정 목록 (ToDo)

- 작성일: 2026-08-20 (최종 갱신: 2026-08-20, HTML/DOCX 내보내기 구현 완료)
- 대상 버전: v0.1.0 이후
- 이 문서는 **구현 계획만** 정리한다. 실제 코드 반영은 각 항목을 착수할 때 진행한다.
- 요구사항 원문은 [doc/README.md](README.md) 참고.

---

## 1. 우선순위 요약

| 순위 | 항목 | 난이도 | 외부 의존성 | 상태 |
|---|---|:---:|---|---|
| 1 | HTML 내보내기 | 낮음 | 없음 | **구현 완료** |
| 2 | DOCX 내보내기 | 중간 | `docx` npm | **구현 완료** (수식 = OMML 네이티브) |
| 3 | HWPX 내보내기 | 높음 | 없음(직접 생성) | 계획 (표준 스펙 기반 직접 구현) |
| 4 | 내보내기 공통 UI/메뉴 | 낮음 | 없음 | **구현 완료** (1번과 함께) |

> HTML/DOCX가 완성되었으므로 다음 착수 대상은 **HWPX 내보내기**다.
> HWPX는 DOCX와 같은 입력(DocModel)을 쓰고, OWPML XML을 만들어 ZIP으로 묶는 구조가 된다.

---

## 2. 내보내기(Export) 메뉴

### 2.1 공통 설계

**메뉴 구조**

```
파일
 ├─ 열기...                Ctrl+O
 ├─ 최근 파일
 ├─ 새로고침               F5
 ├─ 편집 모드 전환         Ctrl+E
 ├─ 저장                   Ctrl+S
 ├─ 인쇄...                Ctrl+P      (구현 완료)
 ├─ 내보내기               ▶ HTML...   Ctrl+Shift+H   (구현 완료)
 │                          DOCX...    Ctrl+Shift+D   (구현 완료)
 │                          HWPX...    Ctrl+Shift+W   (예정)
 └─ 종료                   Ctrl+Q
```

- [ ] 툴바에도 `📤 내보내기` 드롭다운 버튼 추가 검토 (현재는 메뉴/단축키만 제공).
- [x] 문서가 열려 있지 않으면 메뉴 항목 비활성화 — `rebuildMenu()`에서 `enabled: currentFilePath !== null`.
- [x] 편집 모드에서 내보내면 **편집 중인 내용**을 기준으로 한다 (인쇄와 동일한 정책).
- 형식이 늘어나면 `AppCommand`에 `export-<format>`을 추가하고 `ExportRequest.format`만 확장하면 된다.

**처리 흐름**

1. renderer: 편집 중이면 draft를 보기용 DOM에 반영 → 이미지 로드 대기 (인쇄의 `waitForImages` 재사용)
2. renderer → main: `export:run` IPC 로 `{ format, html, markdown }` 전달
3. main: `dialog.showSaveDialog`로 저장 경로 선택 (기본 파일명 = 원본 파일명 + 확장자)
4. main: 포맷별 변환 후 파일 기록
5. renderer: 성공/실패 토스트 표시

**공통 고려사항**

- [x] 변환은 main 프로세스에서 수행 (renderer는 sandbox이므로 파일 쓰기 불가)
- [x] 대용량 문서 변환 중 진행 표시(로딩 오버레이 재사용) — `showLoading('내보내는 중...')`
- [x] 변환 실패 시 부분 파일이 남지 않도록 임시 파일 → rename 방식 — `writeFileAtomic()`
- [x] 내보내기 기본 폴더는 원본 문서와 같은 폴더
- [x] 이미지 경로 해석은 기존 `resolveResourceUrl` 규칙과 동일하게 유지 (renderer가 해석한 결과를 그대로 사용)

### 2.2 HTML 내보내기 — **구현 완료**

`renderMarkdown()`이 만든 sanitize된 DOM을 그대로 재사용한다. 구현: [src/main/export-html.ts](../src/main/export-html.ts).

- [x] 단일 파일(self-contained) 출력: CSS 인라인 + 이미지 base64 임베드
- [x] KaTeX CSS/폰트 임베드 (오프라인 열람 보장, 요구사항 F-306과 동일 기조)
- [x] highlight.js 테마 CSS 인라인 (라이트 테마)
- [x] 복사 버튼(`.copy-btn`) 등 앱 전용 UI 제거
- [x] 라이트 테마 고정 (인쇄와 동일하게 배포용은 흰 배경)
- [ ] 옵션: "이미지 임베드" vs "이미지 폴더 분리(`문서명_files/`)" 선택 — 현재는 임베드만 지원

**결정된 사항**

- 폰트 크기 문제는 **woff2만 임베드**하는 것으로 해결했다. 브라우저는 지원하는 첫 포맷만 내려받으므로
  woff/ttf 폴백은 임베드하지 않아도 되고, KaTeX woff2 전체가 약 300KB라 서브셋까지는 불필요했다.
- **수식이 없는 문서에는 KaTeX CSS/폰트를 아예 넣지 않는다** (`katex` 클래스 존재 여부로 판단).
  실측: 수식 포함 문서 약 400KB, 수식 없는 문서 약 13KB.
- 10MB를 넘는 이미지와 외부(`http(s)`) 이미지는 임베드하지 않고 원본 경로를 유지한다.
  읽지 못한 이미지도 마찬가지(같은 PC에서는 그대로 보인다).
- 문서 제목(`<title>`)은 첫 `h1`, 없으면 확장자를 뗀 파일명을 사용한다.

**검증**

- `buildExportedHtml()` 단위 확인: 이미지 data URI 치환 / 없는 이미지·원격 이미지 경로 유지 / 폰트 인라인 / 제목 이스케이프
- 스모크 테스트(`MDV_SMOKE_EXPORT=<경로>`)로 앱을 실제 실행해 `test-docs/mixed.md`를 내보낸 뒤,
  결과 HTML을 다시 열어 수식·코드 강조·표·임베드 이미지가 모두 정상 표시되는 것을 확인했다.

### 2.3 DOCX 내보내기 — **구현 완료**

**채택한 방식**: `docx` npm 패키지(MIT)로 문서를 조판하고, **수식만 OMML XML을 직접 생성**해 넣는다.

| 검토한 방식 | 결과 |
|---|---|
| `docx` npm 패키지 + OMML 직접 생성 | **채택**. 스타일/표/목록/이미지 처리는 검증된 라이브러리에 맡기고, 수식은 XML을 직접 만들어 완전히 제어 |
| `html-to-docx` 계열로 HTML 변환 | 기각. 세부 서식 제어가 어렵고 수식이 이미지로 떨어진다 |
| Pandoc 외부 실행 | 기각. 배포 크기 증가 대비 이점이 적다 |
| `mathml2omml` npm 패키지 | 기각. LGPL-3.0이라 MIT 저장소의 배포 바이너리에 부담 |

**입력**: renderer가 보기용 DOM에서 만드는 중간 모델 `DocModel`([src/common/docmodel.ts](../src/common/docmodel.ts)).
renderer는 sandbox라 파일을 쓸 수 없고 main에는 HTML/XML 파서가 없으므로,
**DOM 해석은 renderer, 파일 생성은 main**으로 나눴다. HWPX도 같은 입력을 쓴다.

- [x] 한글 폰트 지정 (맑은 고딕 / 코드 D2Coding·Consolas) 및 줄간격 1.3
- [x] 표: 테두리/머리행 배경/정렬 유지
- [x] 코드 블록: 고정폭 + 배경 음영(1칸 표로 감쌈), **구문 강조 색상 유지**
      — hljs 클래스별 색상표를 따로 두지 않고 renderer에서 `getComputedStyle`로 계산된 색을 읽는다
- [x] 이미지: 원본 픽셀 크기 기준 삽입, 본문 폭(A4 - 여백 40mm) 초과 시 축소
- [x] **수식**: MathML → OMML 변환기를 직접 작성 ([src/main/omml.ts](../src/main/omml.ts))
- [x] 체크리스트(`- [x]`)는 글머리표 대신 `☑`/`☐` 기호로

**수식 변환 지원 범위** (KaTeX가 실제로 내보내는 MathML 기준)

| MathML | OMML | 비고 |
|---|---|---|
| `mfrac` | `m:f` | `linethickness=0`이면 `noBar`(이항계수) |
| `msqrt`/`mroot` | `m:rad` | 차수 없는 근호는 `degHide` |
| `msup`/`msub`/`msubsup` | `m:sSup`/`m:sSub`/`m:sSubSup` | |
| `munder`/`mover`/`munderover` | `m:limLow`/`m:limUpp`/`m:acc`/`m:bar` | 강조기호·윗줄은 별도 판별 |
| ∑ ∏ ∫ 등 큰 연산자 | `m:nary` | **뒤따르는 식을 피연산자(`m:e`)로 흡수**해야 Word가 제대로 조판한다 |
| `mtable`/`mtr`/`mtd` | `m:m`/`m:mr`/`m:e` | 행렬·`cases`·`align` |
| `fence="true"` 괄호쌍 | `m:d` | `\left( 
ight)`처럼 높이에 맞춰 늘어남 |
| `mi`(한 글자) | 이탤릭 | `sin`·`log`처럼 여러 글자면 정자체 |
| `mtext` | `m:nor` | 본문 글꼴로 — `	ext{한글}`이 수식 글꼴에서 깨지지 않게 |

**검증**

- Word COM 자동화로 생성 문서를 열어 확인 (math/mixed/korean/code/table/image-test 6종 모두 정상 개봉)
- `math.md`의 수식 12개가 모두 **Word의 OMath 개체로 인식**되고, 선형식으로 되읽었을 때
  적분 상하한·행렬·극한+시그마·근호·분수 구조가 원본과 일치함을 확인
- 참고: 이 PC의 Word는 COM으로 **저장(PDF/HTML 변환)** 호출이 응답하지 않아 화면 캡처 검증은 못 했다.
  (열기·객체 모델 조회는 정상. 기본 프린터가 가상 PDF 드라이버인 것과 관련된 것으로 보인다)

### 2.4 HWPX 내보내기

**배경**

- HWPX는 한글(HWP)의 개방형 문서 포맷으로, **OWPML(XML) 파일들을 ZIP으로 묶은 구조**다 (KS X 6101).
- DOCX와 달리 성숙한 JS 라이브러리가 사실상 없으므로 **XML을 직접 생성**해야 할 가능성이 높다.

**후보 방식**

| 방식 | 장점 | 단점 |
|---|---|---|
| OWPML XML 직접 생성 후 ZIP 패키징 | 외부 의존성 없음, 배포 단순 | 스펙 학습 비용 큼, 검증 어려움 |
| DOCX로 내보낸 뒤 한글에서 열어 저장 안내 | 구현 비용 거의 없음 | 사용자 수작업 필요, "내보내기"라 부르기 어려움 |
| 한글 오피스 COM 자동화 | 변환 품질 보장 | **한글 오피스 설치 필수**, 배포 환경 제약 |

- [ ] 방식 결정 (초안 권장: OWPML 직접 생성. 단, 최소 기능부터 단계적으로)
- [ ] HWPX 최소 구조 확보: `mimetype`, `version.xml`, `Contents/content.hpf`, `Contents/section0.xml`, `Contents/header.xml`, `META-INF/`
- [ ] 1단계 지원 범위: 제목/문단/굵게·기울임/목록/인용
- [ ] 2단계: 표, 이미지(BinData 삽입)
- [ ] 3단계: 코드 블록(고정폭 + 음영), 수식(이미지 삽입으로 우회)
- [ ] 한글 오피스에서 열리는지 실제 검증 절차 마련 (자동 테스트 불가 → 수동 확인 체크리스트 작성)

**리스크**

- 스펙 준수가 조금만 어긋나도 한글에서 "파일이 손상되었습니다"로 열리지 않을 수 있다.
- 초기에는 **매우 단순한 문서부터** 왕복 검증하며 범위를 넓히는 방식이 안전하다.

### 2.5 결정이 필요한 사항

- [x] **수식 처리 방침**: 네이티브 수식 개체(OMML)로 확정. 이미지 방식은 확대 시 깨지고 편집도 불가.
      HWPX도 같은 방침으로 가되, 한글의 수식 개체 표현이 어려우면 그때 이미지 대안을 재검토한다.
- [x] 구문 강조 색상: **유지**. renderer에서 계산된 색을 읽는 방식이라 변환기 복잡도가 거의 늘지 않았다.
- [x] 외부 바이너리(Pandoc 등) 동봉: **하지 않음**.
- [x] 내보내기 시 다크 테마 반영: **하지 않음** (인쇄와 동일하게 라이트 고정)

---

## 3. 기타 후보 기능

- [ ] PDF로 내보내기 (`webContents.printToPDF`) — 인쇄 기능과 코드 상당 부분 공유 가능, 난이도 낮음
- [ ] 목차(TOC) 사이드바 및 현재 위치 하이라이트
- [ ] 문서 내 검색 (Ctrl+F)
- [ ] 인쇄 옵션 대화상자 (용지 크기, 여백, 머리말/꼬리말)
- [ ] 최근 파일 목록에서 개별 항목 제거
- [ ] 여러 문서 탭

---

## 4. 참고: 이미 구현된 관련 기능

인쇄와 HTML 내보내기는 구현 완료되었으며, DOCX/HWPX 구현 시 아래 코드를 재사용할 수 있다.

| 재사용 대상 | 위치 | 용도 |
|---|---|---|
| `renderIntoContent()` | `src/renderer/renderer.ts` | Markdown → 보기용 DOM 렌더링 |
| `waitForImages()` | `src/renderer/renderer.ts` | 이미지 로드 완료 대기 |
| `applyThemeStyles()` | `src/renderer/renderer.ts` | 출력용 라이트 테마 임시 전환 |
| `buildExportBody()` | `src/renderer/renderer.ts` | 앱 UI를 제거한 본문 HTML 추출 — 모든 포맷의 공통 입력 |
| `exportDocument()` | `src/renderer/renderer.ts` | 편집본 반영 → 이미지 대기 → main 호출 → 토스트 (포맷 인자만 다름) |
| `@media print` 규칙 | `src/renderer/styles.css` | 코드/표 줄바꿈, 앱 UI 제거 규칙 |
| `file:export` IPC | `src/main/main.ts` | 저장 대화상자 + 포맷 분기 지점 (여기에 DOCX/HWPX 추가) |
| `writeFileAtomic()` | `src/main/main.ts` | 임시 파일 → rename 방식의 안전한 파일 쓰기 |
| `buildExportedHtml()` | `src/main/export-html.ts` | 정제된 HTML 생성 — DOCX/HWPX의 입력으로 재사용 가능 |
| `embedLocalImages()` | `src/main/export-html.ts` | `file://` 이미지 → data URI (이미지 바이너리 확보 경로) |
| `MDV_SMOKE_EXPORT` | `src/main/main.ts` | 저장 대화상자 없이 내보내기까지 수행하는 스모크 테스트 훅 |
