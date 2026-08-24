import { describe, expect, test } from "vitest";
import { parsePageSpec } from "./cli.js";

describe("parsePageSpec", () => {
  test("expands ranges, removes duplicates, and sorts pages", () => {
    expect(parsePageSpec("15-16,3,16")).toEqual([3, 15, 16]);
  });

  test("rejects zero, descending, and malformed ranges", () => {
    for (const spec of ["0", "16-15", "1-", "pages"])
      expect(() => parsePageSpec(spec)).toThrow("invalid page selection");
  });
});
