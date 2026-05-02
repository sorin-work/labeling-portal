import { Marked, type Tokens } from 'marked';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Links may point to web pages, mail addresses or paths on this site, nothing else. */
export function isSafeUrl(href: string): boolean {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return true;
  // relative links have no scheme at all
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // instructions are written by project managers but read by everyone, so
    // raw HTML is shown as text instead of being rendered
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
  },
  walkTokens(token) {
    if ((token.type === 'link' || token.type === 'image') && !isSafeUrl(token.href)) {
      token.href = '#';
    }
  },
});

/** Renders project instructions (Markdown) to HTML for display. */
export function renderMarkdown(source: string): string {
  if (!source.trim()) return '';
  return marked.parse(source, { async: false });
}
