import type { PageReport } from "./api";

// Native pages are nearly free — the text is already in the file. Scanned pages
// pay the per-page OCR cost measured on this machine by the test run.
const NATIVE_MS_PER_PAGE = 120;
const STARTUP_MS = 2000;

export type Estimate = {
  selected: number;
  scanned: number;
  native: number;
  blank: number;
  /** null when scanned pages are selected but no page has been timed yet. */
  totalMs: number | null;
};

export function estimate(pages: PageReport[], selected: Set<number>, ocrMsPerPage?: number): Estimate {
  const counts = { scanned: 0, native: 0, blank: 0 };
  for (const page of pages) {
    if (!selected.has(page.page)) continue;
    if (page.verdict === "scanned") counts.scanned += 1;
    else if (page.verdict === "native") counts.native += 1;
    else counts.blank += 1;
  }
  const unknown = counts.scanned > 0 && ocrMsPerPage === undefined;
  return {
    ...counts,
    selected: selected.size,
    totalMs: unknown ? null : STARTUP_MS + counts.native * NATIVE_MS_PER_PAGE + counts.scanned * (ocrMsPerPage ?? 0),
  };
}
