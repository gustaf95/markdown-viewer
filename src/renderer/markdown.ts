import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

// ---------------------------------------------------------------------------
// markdown-it 파이프라인
//  - GFM 표/취소선 기본 지원, linkify로 URL 자동 링크
//  - html: true 이지만 최종 출력은 DOMPurify로 sanitize (F-111, F-112, NF-201)
//  - 수식: markdown-it-texmath + KaTeX, $...$ / $$...$$ (F-301~F-306)
//  - 코드: highlight.js (F-401~F-403)
// ---------------------------------------------------------------------------
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  highlight: (code: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* 하이라이팅 실패 시 아래 escape 폴백 (NF-101) */
      }
    }
    return md.utils.escapeHtml(code);
  },
});

md.use(taskLists, { label: false });
md.use(texmath, {
  engine: katex,
  // dollars: $...$ / $$...$$, brackets: \(...\) / \[...\] (LaTeX 표기, F-301~F-303)
  delimiters: ['dollars', 'brackets'],
  katexOptions: {
    throwOnError: false, // 잘못된 수식도 앱을 멈추지 않고 오류 표시 (F-305, NF-102)
    errorColor: '#cc3333',
    strict: false,
  },
});

/** 이미 절대 URL인지 판별 */
const ABSOLUTE_URL_RE = /^(https?:|data:|file:|blob:|mailto:)/i;
/** Windows 절대 경로 (C:\..., C:/..., \\server\share) */
const WINDOWS_PATH_RE = /^([a-zA-Z]:[\\/]|\\\\)/;

/**
 * 이미지/링크의 상대 경로를 Markdown 파일 위치 기준 file:// URL로 변환 (F-601~F-603)
 */
function resolveResourceUrl(src: string, baseDirUrl: string | null): string {
  if (!src || ABSOLUTE_URL_RE.test(src)) return src;
  if (WINDOWS_PATH_RE.test(src)) {
    return 'file:///' + src.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  if (!baseDirUrl) return src;
  try {
    const base = baseDirUrl.endsWith('/') ? baseDirUrl : baseDirUrl + '/';
    return new URL(src.replace(/\\/g, '/'), base).href;
  } catch {
    return src;
  }
}

/** 렌더링 결과 통계 (상태 표시줄 등에 활용 가능) */
export interface RenderResult {
  fragment: DocumentFragment;
}

/**
 * Markdown 원문 -> sanitize된 DocumentFragment
 *  - 이미지 상대 경로 해석 + 로드 실패 시 대체 텍스트 (F-604)
 *  - 코드 블록 복사 버튼 래핑 (F-404)
 */
export function renderMarkdown(source: string, baseDirUrl: string | null): RenderResult {
  let rawHtml: string;
  try {
    rawHtml = md.render(source);
  } catch (err) {
    // 파서가 예외를 던져도 앱이 죽지 않도록 원문을 그대로 보여준다 (NF-101)
    const msg = err instanceof Error ? err.message : String(err);
    rawHtml =
      `<p class="render-error">Markdown 렌더링 중 오류가 발생했습니다: ${md.utils.escapeHtml(msg)}</p>` +
      `<pre>${md.utils.escapeHtml(source)}</pre>`;
  }

  const clean = DOMPurify.sanitize(rawHtml, {
    // 기본 허용 목록(HTML/SVG/MathML)을 사용하되 위험 요소는 확실히 차단
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });

  const template = document.createElement('template');
  template.innerHTML = clean;

  fixImages(template.content, baseDirUrl);
  wrapCodeBlocks(template.content);

  return { fragment: template.content };
}

function fixImages(root: DocumentFragment, baseDirUrl: string | null): void {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    img.setAttribute('src', resolveResourceUrl(src, baseDirUrl));
    img.addEventListener(
    'error',
      () => {
        const fallback = document.createElement('span');
        fallback.className = 'img-fallback';
        const alt = img.getAttribute('alt') || '이미지';
        fallback.textContent = `⚠ 이미지를 찾을 수 없습니다: ${alt} (${src})`;
        img.replaceWith(fallback);
      },
      { once: true },
    );
  });

  // 문서 내 상대 경로 링크(.md 등)도 파일 위치 기준으로 해석해 둔다
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#') || ABSOLUTE_URL_RE.test(href)) return;
    a.setAttribute('href', resolveResourceUrl(href, baseDirUrl));
  });
}

function wrapCodeBlocks(root: DocumentFragment): void {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    code.classList.add('hljs');
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = '복사';
    btn.title = '코드 복사';
    wrap.append(btn, pre);
  });
}
