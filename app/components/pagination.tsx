import { Link, useLocation } from 'react-router';

import type { PageInfo } from '~/lib/pagination';

import { cx } from './ui';

export function Pagination({ info, param = 'page' }: { info: PageInfo; param?: string }) {
  const location = useLocation();
  if (info.pageCount <= 1) return null;

  const hrefFor = (page: number) => {
    const params = new URLSearchParams(location.search);
    params.set(param, String(page));
    return `${location.pathname}?${params}`;
  };
  const from = info.total === 0 ? 0 : info.skip + 1;
  const to = Math.min(info.skip + info.take, info.total);
  const linkClass = 'rounded-md px-3 py-1.5 text-sm ring-1 ring-slate-300 bg-white';

  return (
    <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
      <span className="text-slate-500">
        {from}–{to} of {info.total}
      </span>
      <div className="flex gap-2">
        {info.page > 1 ? (
          <Link to={hrefFor(info.page - 1)} className={cx(linkClass, 'hover:bg-slate-50')}>
            Previous
          </Link>
        ) : (
          <span className={cx(linkClass, 'text-slate-300')}>Previous</span>
        )}
        <span className="px-2 py-1.5 text-slate-500">
          Page {info.page} of {info.pageCount}
        </span>
        {info.page < info.pageCount ? (
          <Link to={hrefFor(info.page + 1)} className={cx(linkClass, 'hover:bg-slate-50')}>
            Next
          </Link>
        ) : (
          <span className={cx(linkClass, 'text-slate-300')}>Next</span>
        )}
      </div>
    </nav>
  );
}
