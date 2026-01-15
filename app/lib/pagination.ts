export const DEFAULT_PAGE_SIZE = 25;

export type PageInfo = {
  page: number;
  pageCount: number;
  pageSize: number;
  skip: number;
  take: number;
  total: number;
};

/** Reads ?page= from a URL. Anything that is not a positive integer means page 1. */
export function readPage(url: URL, param = 'page'): number {
  const value = Number(url.searchParams.get(param));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** Works out which slice of a list to show. Pages past the end are clamped to the last one. */
export function paginate(total: number, requested: number, pageSize = DEFAULT_PAGE_SIZE): PageInfo {
  const pageCount = Math.max(1, Math.floor(total / pageSize));
  const page = Math.min(Math.max(1, requested), pageCount);
  return { page, pageCount, pageSize, skip: (page - 1) * pageSize, take: pageSize, total };
}
