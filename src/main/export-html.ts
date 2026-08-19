import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// HTML 내보내기 (F-1101)
//  - 결과물은 단일 파일(self-contained): CSS/폰트/로컬 이미지를 모두 인라인으로 넣어
//    다른 PC로 옮기거나 메일로 보내도 그대로 열리게 한다.
//  - 본문 HTML은 renderer가 이미 sanitize + 상대 경로 해석까지 마친 상태로 넘어온다.
//  - 배포용이므로 화면 테마와 무관하게 라이트 테마로 고정한다 (인쇄와 동일한 정책).
// ---------------------------------------------------------------------------

/** 인라인으로 임베드할 이미지 1개의 최대 크기. 초과하면 원본 경로를 그대로 둔다 */
const MAX_EMBED_IMAGE_SIZE = 10 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** 내보낸 문서를 앱 UI가 아닌 한 장의 문서로 보이게 하는 최소 오버라이드 */
const EXPORT_CSS = `
/* Markdown Viewer HTML 내보내기 전용 오버라이드 */
html, body { height: auto; display: block; background: #ffffff; }
#content { display: block; padding: 40px 40px 80px; }
.copy-btn { display: none !important; }
`;

/** dist/renderer 아래의 정적 자산 경로 (패키징 후에는 asar 내부 경로가 된다) */
function rendererAsset(...segments: string[]): string {
  return path.join(__dirname, '..', 'renderer', ...segments);
}

function readTextAsset(assetPath: string): string {
  try {
    return fs.readFileSync(assetPath, 'utf8');
  } catch {
    return ''; // 자산이 없어도 내보내기 자체는 계속한다 (해당 스타일만 빠진다)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * KaTeX CSS의 폰트 참조를 data URI로 치환한다.
 * 브라우저는 지원하는 첫 포맷(woff2)만 내려받으므로 woff2만 임베드하면 충분하다.
 * (전체 woff2 약 300KB — 수식이 있는 문서에서만 포함한다)
 */
function inlineKatexCss(): string {
  const css = readTextAsset(rendererAsset('vendor', 'katex', 'katex.min.css'));
  if (!css) return '';
  return css.replace(/url\(\s*(['"]?)fonts\/([A-Za-z0-9_.-]+\.woff2)\1\s*\)/g, (whole, _quote: string, name: string) => {
    try {
      const font = fs.readFileSync(rendererAsset('vendor', 'katex', 'fonts', name));
      return `url(data:font/woff2;base64,${font.toString('base64')})`;
    } catch {
      return whole;
    }
  });
}

/** 본문의 로컬(file://) 이미지를 data URI로 치환 */
function embedLocalImages(html: string): string {
  return html.replace(/(<img\b[^>]*?\ssrc=")([^"]*)(")/gi, (whole, prefix: string, src: string, suffix: string) => {
    if (!/^file:/i.test(src)) return whole; // http(s)/data URI는 그대로 둔다
    try {
      const filePath = fileURLToPath(src);
      const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
      if (!mime) return whole;
      if (fs.statSync(filePath).size > MAX_EMBED_IMAGE_SIZE) return whole;
      const data = fs.readFileSync(filePath).toString('base64');
      return `${prefix}data:${mime};base64,${data}${suffix}`;
    } catch {
      return whole; // 읽지 못한 이미지는 원본 경로 유지 (같은 PC에서는 그대로 보인다)
    }
  });
}

/**
 * 보기용 본문 HTML을 단일 파일 HTML 문서로 조립한다.
 * @param bodyHtml renderer가 넘긴 #content의 innerHTML (복사 버튼 등 앱 UI 제거 상태)
 * @param title <title>에 사용할 문서 제목
 */
export function buildExportedHtml(bodyHtml: string, title: string): string {
  const body = embedLocalImages(bodyHtml);
  // 수식이 없는 문서에까지 KaTeX CSS/폰트를 넣지 않는다
  const needsKatex = /\bkatex\b/.test(body);

  const styles = [
    needsKatex ? inlineKatexCss() : '',
    readTextAsset(rendererAsset('vendor', 'hljs', 'github.min.css')),
    readTextAsset(rendererAsset('styles.css')),
    EXPORT_CSS,
  ].filter((css) => css.trim().length > 0);

  return [
    '<!DOCTYPE html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="generator" content="Markdown Viewer" />',
    `<title>${escapeHtml(title)}</title>`,
    ...styles.map((css) => `<style>\n${css}\n</style>`),
    '</head>',
    '<body data-theme="light">',
    '<article id="content" class="markdown-body">',
    body,
    '</article>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
