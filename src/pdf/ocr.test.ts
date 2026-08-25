import { describe, expect, test } from "vitest";
import { ocrBlocksToBookBlocks, ocrFigures, ocrImageFile, type OcrBlock } from "./ocr.js";

describe("ocrBlocksToBookBlocks", () => {
  test("preserves one semantic paragraph per Paddle block", () => {
    const output = ocrBlocksToBookBlocks(
      [{ text: "DOWN THE RABBIT-HOLE", label: "paragraph_title", x: 0.1, y: 0.08, w: 0.8, h: 0.04 }],
      21
    );
    expect(output).toEqual([{ type: "heading", level: 2, text: "DOWN THE RABBIT-HOLE", page: 21 }]);
  });

  test("uses Paddle layout labels directly", () => {
    const blocks: OcrBlock[] = [
      { text: "Alice was beginning to get tired.", label: "text", x: 0.1, y: 0.2, w: 0.8, h: 0.1 },
      { text: "CHAPTER II", label: "doc_title", x: 0.3, y: 0.05, w: 0.4, h: 0.05 },
    ];
    expect(ocrBlocksToBookBlocks(blocks, 1)).toEqual([
      { type: "text", text: "Alice was beginning to get tired.", page: 1 },
      { type: "heading", level: 1, text: "CHAPTER II", page: 1 },
    ]);
  });

  test("flattens internal newlines and keeps textless figure regions", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "first line\nsecond line", label: "text", x: 0, y: 0, w: 1, h: 0.2 },
        { text: "   ", label: "image", x: 0, y: 0.3, w: 1, h: 0.5 },
      ],
      1
    );
    expect(output).toEqual([
      { type: "text", text: "first line second line", page: 1 },
      { type: "image", file: expect.stringMatching(/^assets\/fig-1-[0-9a-f]{12}\.png$/), page: 1 },
    ]);
  });

  test("maps Paddle furniture labels and preserves missed all-caps heading evidence", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "10", label: "number", x: 0.05, y: 0.02, w: 0.05, h: 0.02 },
        { text: "ALICE IN WONDERLAND", label: "header", x: 0.3, y: 0.02, w: 0.4, h: 0.02 },
        { text: "DOWN THE RABBIT-HOLE", label: "text", x: 0.3, y: 0.2, w: 0.4, h: 0.03 },
      ],
      16
    );
    expect(output).toEqual([{ type: "heading", level: 2, text: "DOWN THE RABBIT-HOLE", page: 16 }]);
  });

  test("keeps adjacent OCR paragraphs separate", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "First paragraph.", label: "text", x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
        { text: "Second paragraph.", label: "text", x: 0.1, y: 0.3, w: 0.8, h: 0.1 },
      ],
      15
    );
    expect(output).toHaveLength(2);
    expect(output.map((block) => "text" in block ? block.text : "")).toEqual(["First paragraph.", "Second paragraph."]);
  });
});

// The real page-19 layout of corpus/pdf/alice-scan.pdf, normalized from the
// 1099×1677 render PaddleOCR-VL 1.6 saw.
const ALICE_PAGE_19: OcrBlock[] = [
  { text: "DOWN THE RABBIT-HOLE", label: "header", x: 0.283, y: 0.064, w: 0.427, h: 0.021 },
  { text: "13", label: "number", x: 0.854, y: 0.067, w: 0.035, h: 0.018 },
  { text: "behind it when she turned the corner,", label: "text", x: 0.1, y: 0.097, w: 0.792, h: 0.102 },
  { text: "", label: "image", x: 0.122, y: 0.352, w: 0.765, h: 0.432 },
  {
    text: "She tried the little golden key in the lock.",
    label: "vision_footnote",
    x: 0.262,
    y: 0.802,
    w: 0.471,
    h: 0.02,
  },
  { text: "Suddenly she came upon a little table.", label: "text", x: 0.102, y: 0.831, w: 0.795, h: 0.106 },
];

describe("figure regions", () => {
  test("a textless image block becomes a real image block", () => {
    const output = ocrBlocksToBookBlocks(ALICE_PAGE_19, 19);
    const image = output.find((block) => block.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", page: 19 });
  });

  test("names the asset deterministically from page and bounding box", () => {
    const [figure] = ocrFigures(ALICE_PAGE_19);
    expect(figure).toBeDefined();
    const file = ocrImageFile(19, figure!);
    expect(file).toBe(ocrImageFile(19, { ...figure! }));
    expect(file).not.toBe(ocrImageFile(20, figure!));
    expect(file).toMatch(/^assets\/fig-19-[0-9a-f]{12}\.png$/);
    expect(ocrBlocksToBookBlocks(ALICE_PAGE_19, 19)).toContainEqual(expect.objectContaining({ file }));
  });

  test("a vision block the provider did read keeps its text", () => {
    expect(
      ocrBlocksToBookBlocks([{ text: "Sales rose 4%.", label: "chart", x: 0.1, y: 0.1, w: 0.8, h: 0.4 }], 5)
    ).toEqual([{ type: "text", text: "Sales rose 4%.", page: 5 }]);
  });

  test("skips specks and whole-page regions", () => {
    expect(
      ocrFigures([
        { text: "", label: "image", x: 0.5, y: 0.5, w: 0.01, h: 0.3 },
        { text: "", label: "image", x: 0.5, y: 0.5, w: 0.3, h: 0.005 },
        { text: "", label: "image", x: 0, y: 0, w: 1, h: 1 },
        { text: "", label: "header_image", x: 0.1, y: 0.02, w: 0.8, h: 0.2 },
        { text: "", label: "image", x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
      ])
    ).toEqual([{ text: "", label: "image", x: 0.1, y: 0.1, w: 0.8, h: 0.6 }]);
  });
});

describe("captions", () => {
  test("binds a vision_footnote to the illustration it sits under", () => {
    const output = ocrBlocksToBookBlocks(ALICE_PAGE_19, 19);
    expect(output).toContainEqual({
      type: "image",
      file: expect.any(String),
      page: 19,
      caption: "She tried the little golden key in the lock.",
    });
    expect(output.some((block) => block.role === "caption")).toBe(false);
    expect(JSON.stringify(output)).not.toContain("footnote-source");
  });

  test("an unbound caption stays a caption paragraph, never a footnote", () => {
    const output = ocrBlocksToBookBlocks(
      [{ text: "Fig. 1 — the hall of doors.", label: "vision_footnote", x: 0.2, y: 0.8, w: 0.5, h: 0.02 }],
      7
    );
    expect(output).toEqual([{ type: "text", role: "caption", text: "Fig. 1 — the hall of doors.", page: 7 }]);
  });

  test("a caption far from the figure is not bound to it", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "", label: "image", x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
        { text: "A distant caption.", label: "figure_title", x: 0.1, y: 0.8, w: 0.8, h: 0.02 },
      ],
      3
    );
    expect(output).toHaveLength(2);
    expect(output[0]).not.toHaveProperty("caption");
    expect(output[1]).toMatchObject({ type: "text", role: "caption" });
  });

  test("a genuine footnote label still maps to footnote-source", () => {
    const output = ocrBlocksToBookBlocks(
      [{ text: "1. See Carroll, 1865.", label: "footnote", x: 0.1, y: 0.9, w: 0.5, h: 0.02 }],
      44
    );
    expect(output).toEqual([{ type: "text", role: "footnote-source", text: "1. See Carroll, 1865.", page: 44 }]);
  });
});

describe("tables", () => {
  const rowsOf = (text: string, label = "table") => {
    const [block] = ocrBlocksToBookBlocks([{ text, label, x: 0.1, y: 0.1, w: 0.8, h: 0.3 }], 2);
    return block;
  };

  test("parses the HTML PaddleOCR-VL actually returns", () => {
    expect(
      rowsOf("<table><tr><td>ALICE IN WONDERLAND</td></tr><tr><td>-</td></tr></table>")
    ).toEqual({ type: "table", rows: [["ALICE IN WONDERLAND"], ["-"]], page: 2 });
  });

  test("reads thead/tbody, th cells, entities and inline markup", () => {
    expect(
      rowsOf(
        "<table><thead><tr><th>Drink</th><th>Price</th></tr></thead>" +
          "<tbody><tr><td>Melange &amp; more</td><td>&#8364;4.20</td></tr>" +
          "<tr><td><b>Einspanner</b></td><td>4,80&nbsp;EUR</td></tr></tbody></table>"
      )
    ).toEqual({
      type: "table",
      rows: [
        ["Drink", "Price"],
        ["Melange & more", "€4.20"],
        ["Einspanner", "4,80 EUR"],
      ],
      page: 2,
    });
  });

  test("escapes dialect specials inside cells", () => {
    expect(rowsOf("<table><tr><td>costs $4</td><td>a*b [c]</td></tr></table>")).toEqual({
      type: "table",
      rows: [["costs \\$4", "a\\*b \\[c\\]"]],
      page: 2,
    });
  });

  test("tolerates unclosed cells and pads short rows", () => {
    expect(rowsOf("<table><tr><td>a<td>b</tr><tr><td>c</tr></table>")).toEqual({
      type: "table",
      rows: [["a", "b"], ["c", ""]],
      page: 2,
    });
  });

  test("refuses spans rather than reshaping them, degrading to table-source", () => {
    const block = rowsOf('<table><tr><td colspan="2">Wide</td></tr><tr><td>a</td><td>b</td></tr></table>');
    expect(block).toMatchObject({ type: "text", role: "table-source" });
  });

  test("still reads pipe-delimited Markdown tables", () => {
    expect(rowsOf("| Melange | 4.20 |\n| --- | --- |\n| Einspanner | 4.80 |")).toEqual({
      type: "table",
      rows: [
        ["Melange", "4.20"],
        ["Einspanner", "4.80"],
      ],
      page: 2,
    });
  });

  test("degrades unparseable table text instead of dropping it", () => {
    expect(rowsOf("Kopplungskonstanten, columns unreadable")).toEqual({
      type: "text",
      role: "table-source",
      text: "Kopplungskonstanten, columns unreadable",
      page: 2,
    });
  });

  test("a table_title is a caption, not a table", () => {
    expect(rowsOf("Table 2.2 — coupling constants.", "table_title")).toEqual({
      type: "text",
      role: "caption",
      text: "Table 2.2 — coupling constants.",
      page: 2,
    });
  });
});
