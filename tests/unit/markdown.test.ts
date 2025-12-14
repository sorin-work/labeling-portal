import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '~/domain/markdown';

describe('renderMarkdown', () => {
  it('renders headings, lists and emphasis', () => {
    const html = renderMarkdown('# Guide\n\n- one\n- **two**');
    expect(html).toContain('<h1>Guide</h1>');
    expect(html).toContain('<li><strong>two</strong></li>');
  });

  it('returns nothing for blank input', () => {
    expect(renderMarkdown('   \n')).toBe('');
  });

  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
  });
});
