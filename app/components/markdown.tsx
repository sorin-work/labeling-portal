import { cx } from './ui';

/** Shows HTML produced by renderMarkdown with readable typography. */
export function MarkdownBody({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cx(
        'space-y-3 text-sm leading-6 text-slate-700 [&_a]:text-indigo-700 [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-100 [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
