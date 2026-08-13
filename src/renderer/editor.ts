import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';

/**
 * Typora식 WYSIWYG 편집기 (Milkdown Crepe, ProseMirror 기반)
 *  - 본문을 렌더링된 상태로 직접 편집
 *  - 수식($...$, $$...$$)은 클릭하면 raw LaTeX 편집 + 실시간 미리보기 (Latex feature)
 *  - 상대 경로 이미지는 문서 위치(dirUrl) 기준으로 표시
 *
 * 참고: \(...\) / \[...\] 표기 수식은 편집 모드에서는 일반 텍스트로 보이며
 * (원문은 그대로 보존됨), 보기 모드에서 정상 렌더링된다.
 */
export interface EditorHandle {
  getMarkdown(): string;
  destroy(): Promise<void>;
}

const ABSOLUTE_URL_RE = /^(https?:|data:|file:|blob:|mailto:)/i;

export async function createEditor(
  root: HTMLElement,
  markdown: string,
  baseDirUrl: string | null,
  onChange: () => void,
): Promise<EditorHandle> {
  let armed = false; // create 직후 발생하는 초기 markdownUpdated는 무시

  const resolveImageUrl = (url: string): string => {
    if (!url || ABSOLUTE_URL_RE.test(url) || !baseDirUrl) return url;
    try {
      const base = baseDirUrl.endsWith('/') ? baseDirUrl : baseDirUrl + '/';
      return new URL(url.replace(/\\/g, '/'), base).href;
    } catch {
      return url;
    }
  };

  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: {
      [Crepe.Feature.Latex]: true,
    },
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: {
        proxyDomURL: resolveImageUrl,
      },
    },
  });

  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, next, prev) => {
      if (armed && next !== prev) onChange();
    });
  });

  await crepe.create();
  window.setTimeout(() => { armed = true; }, 300);

  return {
    getMarkdown: () => crepe.getMarkdown(),
    destroy: async () => { await crepe.destroy(); },
  };
}
