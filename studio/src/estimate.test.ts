import { describe, expect, test } from "vitest";
import type { PageReport } from "./api";
import { estimate } from "./estimate";

const page = (page: number, verdict: PageReport["verdict"]): PageReport => ({
  page,
  verdict,
  chars: 0,
  imageCoverage: 0,
  garble: 0,
});

const book = [page(1, "native"), page(2, "scanned"), page(3, "no-text"), page(4, "scanned")];
const all = new Set([1, 2, 3, 4]);

describe("estimate", () => {
  test("counts only the pages that were selected", () => {
    expect(estimate(book, new Set([1, 2]), 1000)).toMatchObject({ selected: 2, native: 1, scanned: 1, blank: 0 });
  });

  test("charges the measured cost per scanned page", () => {
    // 2s of startup, one native page at 120ms, two scanned at the measured 5s
    expect(estimate(book, all, 5_000).totalMs).toBe(2_000 + 120 + 2 * 5_000);
  });

  // Guessing is what the whole "read one page" step exists to avoid.
  test("reports no total at all when a scan has not been timed", () => {
    expect(estimate(book, all, undefined).totalMs).toBeNull();
  });

  test("needs no timing when nothing selected has to be recognized", () => {
    expect(estimate(book, new Set([1, 3]), undefined).totalMs).toBe(2_000 + 120);
  });

  test("an empty selection costs only startup", () => {
    expect(estimate(book, new Set(), undefined)).toMatchObject({ selected: 0, totalMs: 2_000 });
  });
});
