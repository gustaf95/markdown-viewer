declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';
  const plugin: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default plugin;
}
