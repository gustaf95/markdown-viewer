/**
 * 렌더러 정적 자산을 dist/renderer 로 복사한다.
 *  - index.html, styles.css
 *  - KaTeX CSS + 폰트 (오프라인 수식 렌더링, F-306)
 *  - highlight.js 라이트/다크 테마 CSS
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'renderer');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copy(s, d);
  }
}

copy(path.join(root, 'src', 'renderer', 'index.html'), path.join(out, 'index.html'));
copy(path.join(root, 'src', 'renderer', 'styles.css'), path.join(out, 'styles.css'));

const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
copy(path.join(katexDist, 'katex.min.css'), path.join(out, 'vendor', 'katex', 'katex.min.css'));
copyDir(path.join(katexDist, 'fonts'), path.join(out, 'vendor', 'katex', 'fonts'));

const hljsStyles = path.join(root, 'node_modules', 'highlight.js', 'styles');
copy(path.join(hljsStyles, 'github.min.css'), path.join(out, 'vendor', 'hljs', 'github.min.css'));
copy(path.join(hljsStyles, 'github-dark.min.css'), path.join(out, 'vendor', 'hljs', 'github-dark.min.css'));

console.log('assets copied to', out);
