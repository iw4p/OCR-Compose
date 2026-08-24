import { describe, expect, test } from "vitest";
import { garbleScore, judgePage } from "./textlayer.js";
import type { PdfPage } from "./extract.js";

function page(text: string, imageCoverage: number): PdfPage {
  return {
    page: 1,
    width: 322,
    height: 484,
    imageCoverage,
    fonts: new Set(["F"]),
    lines: text
      ? [{ runs: [{ text, font: "F", size: 10, italic: false, bold: false, x: 40, y: 50, w: 200, h: 10 }], x: 40, y: 50, w: 200, h: 10, page: 1 }]
      : [],
  };
}

describe("garbleScore", () => {
  test("clean prose in several languages scores near zero", () => {
    for (const s of [
      "Alice was beginning to get very tired of sitting by her sister.",
      "Der Übergang zur Feldtheorie erfolgt durch das Feld.",
      "Le principe de moindre action est le plus beau théorème.",
    ])
      expect(garbleScore(s)).toBeLessThan(0.1);
  });

  test("OCR garbage scores high", () => {
    expect(garbleScore("Al1ce w4s beg1nn1ng t0 gct vcry t1rcd 0f s1tt1ng")).toBeGreaterThan(0.4);
    expect(garbleScore("xj qwrtz kfjd mnbvc pqrst wxzkj dfghj")).toBeGreaterThan(0.4);
  });
});

describe("judgePage", () => {
  test("text without a page image is native", () => {
    expect(judgePage(page("Ordinary readable paragraph text here.", 0)).verdict).toBe("native");
  });

  test("a page with neither text nor image content is no-text", () => {
    expect(judgePage(page("", 0)).verdict).toBe("no-text");
  });

  test("full-page image with clean hidden text is still scanned", () => {
    expect(judgePage(page("DOWN THE RABBIT-HOLE and other readable words here", 0.95)).verdict).toBe("scanned");
  });

  test("full-page image with garbled hidden text is scanned", () => {
    expect(judgePage(page("D0WN THL R4BB1T-H0LE 4nd 0thcr g4rblcd w0rds hcrc xjq", 0.95)).verdict).toBe(
      "scanned"
    );
  });

  test("image-only content is scanned but a genuinely blank page is no-text", () => {
    expect(judgePage(page("", 0.6)).verdict).toBe("scanned");
    expect(judgePage(page("", 0)).verdict).toBe("no-text");
  });
});
