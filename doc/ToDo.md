# Markdown Viewer — 구현 예정 목록 (ToDo)

- 작성일: 2026-08-20 (최종 갱신: 2026-08-20, HTML/DOCX/HWPX 내보내기 구현 완료)
- 대상 버전: v0.1.0 이후
- 이 문서는 **구현 계획만** 정리한다. 실제 코드 반영은 각 항목을 착수할 때 진행한다.
- 요구사항 원문은 [doc/README.md](README.md) 참고.

---

## 1. 우선순위 요약

| 순위 | 항목 | 난이도 | 외부 의존성 | 상태 |
|---|---|:---:|---|---|
| 1 | HTML 내보내기 | 낮음 | 없음 | **구현 완료** |
| 2 | DOCX 내보내기 | 중간 | `docx` npm | **구현 완료** (수식 = OMML 네이티브) |
| 3 | HWPX 내보내기 | 높음 | 없음(직접 생성) | **구현 완료** (수식 = 한글 수식 개체 네이티브) |
| 4 | 내보내기 공통 UI/메뉴 | 낮음 | 없음 | **구현 완료** (1번과 함께) |

> 세 형식 모두 구현되었다. HWPX는 DOCX와 같은 입력(DocModel)을 쓰고,
> OWPML XML을 직접 만들어 ZIP으로 묶는다 (외부 의존성 없음).

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
 │                          HWPX...    Ctrl+Shift+W   (구현 완료)
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

### 2.4 HWPX 내보내기 — **구현 완료**

**채택한 방식**: OWPML(XML) 직접 생성 + 자체 ZIP 패키징. 외부 의존성을 하나도 늘리지 않았다.

| 검토한 방식 | 결과 |
|---|---|
| OWPML XML 직접 생성 후 ZIP 패키징 | **채택**. 배포가 단순하고 수식까지 완전히 제어된다 |
| DOCX로 내보낸 뒤 한글에서 열어 저장 안내 | 기각. 사용자 수작업이 필요해 "내보내기"라 부르기 어렵다 |
| 한글 오피스 COM 자동화 | 기각. 한글이 설치된 PC에서만 동작한다 |

**구현 파일**

| 파일 | 역할 |
|---|---|
| [src/main/export-hwpx.ts](../src/main/export-hwpx.ts) | DocModel -> OWPML 본문/머리말 XML, 꾸러미 조립 |
| [src/main/hwp-eqn.ts](../src/main/hwp-eqn.ts) | MathML -> **한글 수식 스크립트** 변환 |
| [src/main/zip.ts](../src/main/zip.ts) | 의존성 없는 최소 ZIP 작성기 (mimetype 무압축 선두 배치) |

**꾸러미 구성** — 한글 2020이 실제로 저장한 파일을 뜯어 그대로 맞췄다.

```
mimetype                  (무압축, 맨 앞)   application/hwp+zip
version.xml               (무압축)
Contents/header.xml       글자·문단 모양 목록, 글꼴, 테두리/배경
Contents/section0.xml     본문
Contents/content.hpf      OPF 꾸러미 목록 (이미지도 여기에 등록)
settings.xml
META-INF/container.xml · manifest.xml · container.rdf
Preview/PrvText.txt
BinData/imageN.png        (이미지가 있을 때만)
```

- [x] 1단계: 제목/문단/굵게·기울임·취소선/목록/인용
- [x] 2단계: 표(머리행 음영·정렬), 이미지(BinData 삽입, 블록·인라인 모두)
- [x] 3단계: 코드 블록(고정폭 + 음영 + **구문 강조 색상 유지**), **수식 = 네이티브 수식 개체**
- [x] 한글에서 열리는지 실제 검증 (아래 참고)
- [ ] 하이퍼링크: 지금은 파란 밑줄 글자로만 남긴다. 실제 링크는 필드 컨트롤이라 구조가 복잡해 미뤘다
- [ ] 문단 안 강제 줄바꿈(`<br>`)은 공백으로 대체된다

**수식 처리 — 이 기능의 핵심**

한글 수식은 Word의 OMML과 달리 **자체 스크립트 언어**를 쓴다. HWPX에서는 그 문자열이
`<hp:equation><hp:script>`에 그대로 들어가고, 한글이 파일을 열 때 직접 조판한다.
따라서 이미지로 붙이는 방식과 달리 확대해도 깨지지 않고 한글에서 편집도 된다.

문법은 추측하지 않고 **한글 2020을 COM으로 띄워 실제 조판 결과를 눈으로 확인**하며 확정했다.
그 과정에서 밝혀진, 문서만 봐서는 알기 어려운 사실들:

| 확인한 것 | 내용 |
|---|---|
| 유니코드 기호 | `≤ × → ∂` 등은 그대로 써도 인식된다. 다만 **이름표가 있으면 이름표를 쓴다** — 편집기에서 알아보기 쉽다 |
| 큰 연산자 | `∑`·`∏`는 유니코드로 두면 한계값이 **옆에** 붙는다. `sum`·`prod` 이름표라야 위아래로 간다 |
| 양방향 화살표 | `leftrightarrow`·`Leftrightarrow`는 한쪽 화살표로 **잘못** 조판된다. ↔ ⇔는 유니코드로 둔다 |
| `pm`/`mp` | **인식되지 않는다**. ±는 유니코드나 `+-`를 써야 한다 |
| escape | `{ } & # \` 는 backslash가 통하지만 `^ _` 는 통하지 않아 따옴표 문자열로 감싼다 |
| `#` | 어디서나 줄바꿈이라 본문 문자로 쓰려면 반드시 escape 해야 한다 |
| 따옴표 문자열 | `"..."` 는 공백과 한글을 그대로 유지하며 정자체로 나온다 — `\text{}` 대응에 가장 적합 |
| `left`/`right` 뒤 구분자 | escape하면 안 된다. `left \{` 는 괄호가 아니라 역슬래시가 그려진다 |
| 한쪽만 있는 괄호 | `left { ... right .` 로 짝을 맞춘다 (`cases` 환경) |
| 수식 크기 | `<hp:sz>`는 캐시라 어림값이어도 된다. 일부러 틀린 값을 넣어도 한글이 열 때 다시 계산했다 |

**출력 형식 — 범위는 언제나 중괄호로 명시한다**

한글 수식은 공백만으로 묶이는 범위가 모호하다. `a over b c`는 사람도 한글도 어디까지가
분모인지 알 수 없다. 그래서 첨자 인자·분자/분모·큰 연산자의 피연산자를 모두 `{...}`로 감싼다.

```
int_{0}^{T_{s}} {phi_{1}(t) phi_{2}(t)~dt}=0
sum_{i=1}^{n} {i^{2}}={n(n+1)(2n+1)} over {6}
```

- 첨자는 밑동에 바로 붙이고(`x_{1}`, 앞 공백 없음) 인자는 반드시 중괄호로 감싼다
- 큰 연산자의 피연산자는 **관계 기호(`=`, `≤` ...) 직전까지** 모아 중괄호로 묶는다
- 여러 글자 이름(`sin`, `alpha`, `over`)은 앞뒤를 띄우고, 한 글자 변수·숫자끼리는 붙인다
  (`d t` -> `dt`, `2 a` -> `2a`) — 뜻은 같고 편집기에서 읽기 쉽다

**변환 지원 범위** (KaTeX가 실제로 내보내는 MathML 기준)

| MathML | 한글 수식 | 비고 |
|---|---|---|
| `mfrac` | `{a} over {b}` | `linethickness=0`이면 `atop`(이항계수) |
| `msqrt`/`mroot` | `sqrt {}` / `root {n} of {}` | |
| `msup`/`msub`/`msubsup` | `x^{}` / `x_{}` / `x_{}^{}` | 인자는 항상 중괄호 |
| `munderover` + ∑·∫ | `sum_{}^{} {피연산자}` | 이름표로 치환하고 피연산자를 묶는다 |
| `munder` + lim | `lim_{}` | 함수 이름은 중괄호로 감싸지 않는다 |
| `mover`/`munder` | `hat` `vec` `bar` `tilde` `dot` `ddot` `overline` `underline` | 강조기호·윗줄 판별 |
| `mtable` | `matrix{a & b # c & d}` | 행렬·`cases`·`align` |
| `fence="true"` 괄호쌍 | `left ( ... right )` | 높이에 맞춰 늘어남 |
| `mtext` | `"..."` | 공백·한글 보존 |
| `mi`(여러 글자) | `sin`·`log`는 그대로, 나머지는 따옴표 | 정자체 확보 |
| 그리스 문자·기호 | `alpha` `phi` `GAMMA` `leq` `times` ... | 이름표를 쓰고, 없는 것만 유니코드 |

**검증**

한글 오피스 COM 자동화로 **왕복 검증 절차**를 만들어 썼다:
생성한 `.hwpx`를 한글로 열고 → PDF로 저장 → 이미지로 변환해 눈으로 확인.

- 제목/문단/굵게·기울임·취소선/인라인 코드/중첩 목록/번호 목록/체크리스트/인용문/수평선 정상
- 코드 블록: 배경 음영과 구문 강조 색상이 살아 있고, 여러 줄이 테두리 하나로 묶임
- 표: 머리행 음영, 가운데/오른쪽 정렬, **칸 안의 수식**까지 정상
- 이미지: 블록·인라인, 한글 파일명, 읽지 못한 이미지의 대체 문구 정상
- 수식: 근의 공식 / `∑` 위아래 한계 / 정적분 / 행렬 / `cases` / `lim` / 이항계수 /
  `\left. ... \right|_{x=0}` / 강조기호 / escape 문자 모두 원본과 같은 모양으로 조판됨

"파일이 손상되었습니다" 없이 열리는지가 가장 큰 관문이었는데, 한글이 저장한 실제 파일을
기준선으로 삼아 구조를 맞춘 덕에 처음부터 통과했다.

### 2.5 결정이 필요한 사항

- [x] **수식 처리 방침**: 네이티브 수식 개체로 확정 (DOCX=OMML, HWPX=한글 수식 스크립트).
      이미지 방식은 확대 시 깨지고 편집도 불가. 두 형식 모두 이미지 대안 없이 해결됐다.
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
| `buildDocModel()` | `src/renderer/docmodel.ts` | 보기용 DOM -> DocModel — DOCX/HWPX 공통 입력 |
| `buildZip()` | `src/main/zip.ts` | 의존성 없는 ZIP 작성기 — 다른 압축 형식에도 재사용 가능 |
