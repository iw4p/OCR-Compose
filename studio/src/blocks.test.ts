import { describe, expect, test } from "vitest";
import { describeBlock } from "./blocks";

describe("describeBlock", () => {
  test("names the heading level a block will become", () => {
    expect(describeBlock({ type: "heading", level: 2, text: "Pig and Pepper" })).toEqual({
      kind: "h2",
      text: "Pig and Pepper",
    });
  });

  test("shows a demoted paragraph's role rather than calling it prose", () => {
    expect(describeBlock({ type: "text", role: "running-header", text: "ALICE" }).kind).toBe("running-header");
    expect(describeBlock({ type: "text", text: "Once upon a time" }).kind).toBe("paragraph");
  });

  test("summarizes a parsed table by its shape", () => {
    expect(describeBlock({ type: "table", rows: [["a", "b"], ["c", "d"], ["e", "f"]] }).text).toBe("3 × 2 cells");
  });

  // A table with no grid becomes a picture in the EPUB; say so instead of
  // showing an empty row count.
  test("is explicit when a table could not be parsed into a grid", () => {
    expect(describeBlock({ type: "table", rows: null, image: "assets/t.png" }).text).toMatch(/picture/);
  });

  test("falls back to something readable when a block carries no text", () => {
    expect(describeBlock({ type: "image", file: "assets/fig.png" }).text).toBe("(image, no caption)");
    expect(describeBlock({ type: "formula", display: true, tex: null, image: "assets/eq.png" }).text).toBe("(image)");
  });
});
