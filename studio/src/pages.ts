import type { PageReport } from "./api";

/**
 * `1,3-5,9` → the pages it names. A fragment that is not a page or a range is
 * skipped: this runs on every keystroke of a half-typed selection, so junk is
 * ignored rather than raised.
 */
export function parseRange(input: string, max: number): Set<number> {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) continue;
    for (let page = Number(match[1]); page <= Number(match[2] ?? match[1]); page++)
      if (page >= 1 && page <= max) pages.add(page);
  }
  return pages;
}

export const allPages = (reports: PageReport[]) => new Set(reports.map((report) => report.page));

/** Blank pages carry nothing, so they are off by default and one click away. */
export const pagesWithContent = (reports: PageReport[]) =>
  new Set(reports.filter((report) => report.verdict !== "no-text").map((report) => report.page));

export function togglePage(selected: Set<number>, page: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(page)) next.add(page);
  return next;
}
