import { describe, expect, test } from "vitest";
import type { PageReport } from "./api";
import { allPages, pagesWithContent, parseRange, togglePage } from "./pages";

const report = (page: number, verdict: PageReport["verdict"]): PageReport => ({
  page,
  verdict,
  chars: 0,
  imageCoverage: 0,
  garble: 0,
});

describe("parseRange", () => {
  test("reads single pages and ranges", () => {
    expect([...parseRange("1,3-5,9", 20)]).toEqual([1, 3, 4, 5, 9]);
  });

  test("ignores whitespace and repeats", () => {
    expect([...parseRange(" 2 , 2, 1 - 3 ", 20)]).toEqual([2, 1, 3]);
  });

  test("clamps to the document instead of inventing pages", () => {
    expect([...parseRange("8-12", 10)]).toEqual([8, 9, 10]);
    expect([...parseRange("0,11", 10)]).toEqual([]);
  });

  test("skips fragments that are not pages — this runs on every keystroke", () => {
    expect([...parseRange("1,,abc,-,4", 10)]).toEqual([1, 4]);
    expect([...parseRange("", 10)]).toEqual([]);
  });

  test("a backwards range selects nothing rather than everything", () => {
    expect([...parseRange("9-2", 10)]).toEqual([]);
  });
});

describe("selection", () => {
  const reports = [report(1, "native"), report(2, "no-text"), report(3, "scanned")];

  test("all takes every page, content skips the blanks", () => {
    expect([...allPages(reports)]).toEqual([1, 2, 3]);
    expect([...pagesWithContent(reports)]).toEqual([1, 3]);
  });

  test("toggling adds, removes, and never mutates what it was given", () => {
    const selected = new Set([1, 2]);
    expect([...togglePage(selected, 3)]).toEqual([1, 2, 3]);
    expect([...togglePage(selected, 1)]).toEqual([2]);
    expect([...selected]).toEqual([1, 2]);
  });
});
