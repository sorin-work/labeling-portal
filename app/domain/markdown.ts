import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false });

/** Renders project instructions (Markdown) to HTML for display. */
export function renderMarkdown(source: string): string {
  if (!source.trim()) return '';
  return marked.parse(source, { async: false });
}
