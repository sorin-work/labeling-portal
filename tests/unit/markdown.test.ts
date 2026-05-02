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

describe('renderMarkdown safety', () => {
  it('shows raw html as text', () => {
    const html = renderMarkdown(
      'Hello <script>alert(1)</script>\n\n<img src=x onerror="alert(2)">',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises javascript links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1)) and ![x](data:text/html,boom)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="#"');
  });

  it('keeps normal links', () => {
    expect(renderMarkdown('[guide](https://example.com/guide)')).toContain(
      'href="https://example.com/guide"',
    );
    expect(renderMarkdown('[faq](/projects/abc)')).toContain('href="/projects/abc"');
  });
});
