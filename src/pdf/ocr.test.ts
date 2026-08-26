import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ocrBlocksToBookBlocks,
  ocrCache,
  ocrFigures,
  ocrImageFile,
  onnxtrBlocks,
  onnxtrLabel,
  onnxtrRecognizer,
  onnxtrTableHtml,
  paddleEngine,
  type OcrBlock,
  type OnnxtrItem,
} from "./ocr.js";
import { DEMOTED_ROLES } from "../contract.js";

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

  test("demotes Paddle furniture labels and preserves missed all-caps heading evidence", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "10", label: "number", x: 0.05, y: 0.02, w: 0.05, h: 0.02 },
        { text: "ALICE IN WONDERLAND", label: "header", x: 0.3, y: 0.02, w: 0.4, h: 0.02 },
        { text: "Free eBooks at Planet eBook", label: "footer", x: 0.3, y: 0.95, w: 0.4, h: 0.02 },
        { text: "DOWN THE RABBIT-HOLE", label: "text", x: 0.3, y: 0.2, w: 0.4, h: 0.03 },
      ],
      16
    );
    // I3 — demoted, not deleted; every role here is one the emitter hides
    expect(output).toEqual([
      { type: "text", role: "page-number", text: "10", page: 16 },
      { type: "text", role: "running-header", text: "ALICE IN WONDERLAND", page: 16 },
      { type: "text", role: "running-footer", text: "Free eBooks at Planet eBook", page: 16 },
      { type: "heading", level: 2, text: "DOWN THE RABBIT-HOLE", page: 16 },
    ]);
    for (const block of output.slice(0, 3)) expect(DEMOTED_ROLES).toContain(block.role!);
  });

  test("a furniture region with no text is dropped, having nothing to preserve", () => {
    expect(
      ocrBlocksToBookBlocks([{ text: "  ", label: "header_image", x: 0.1, y: 0.02, w: 0.8, h: 0.05 }], 4)
    ).toEqual([]);
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

describe("page cache", () => {
  const page = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const cached: OcrBlock[] = [{ text: "from disk", label: "text", x: 0.1, y: 0.1, w: 0.8, h: 0.1 }];
  const dir = () => mkdtemp(join(tmpdir(), "bookforge-ocr-cache-"));

  test("Paddle still addresses the entries already written under .bookforge-cache", async () => {
    // Pinned against the real 1.6 entries on disk: this hex is what the shipped
    // key derivation produces for this page. If it moves, every page recognized
    // so far is silently orphaned and paid for again.
    const key = "a08c5bb528d9a4e0caaecb5d5268d51f222e605ed577237ad5f678d99e949929";
    const cacheDir = await dir();
    await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(cached));
    // a hit must not reach for Python at all: neither of these paths exists
    const engine = paddleEngine({ cacheDir, pythonPath: "/nonexistent/python", helperPath: "/nonexistent.py" });
    expect(await engine.recognize(page, ["en"])).toEqual(cached);
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("the key covers the provider identity, the page and the languages", async () => {
    const keys = new Set<string>();
    const seen = async (identity: string, png: Uint8Array, languages: string[]) => {
      await ocrCache(null, identity)(png, languages, async (key) => {
        keys.add(key);
        return [];
      });
    };
    await seen("PaddleOCR-VL-1.6+figures", page, ["en"]);
    await seen("PaddleOCR-VL-1.6+figures", page, ["en"]);
    expect(keys.size).toBe(1);
    await seen("PaddleOCR-VL-1.6", page, ["en"]);
    await seen("PaddleOCR-VL-1.6+figures", new Uint8Array([...page, 4]), ["en"]);
    await seen("PaddleOCR-VL-1.6+figures", page, ["de"]);
    expect(keys.size).toBe(4);
  });

  test("an empty page is a hit, and a corrupt entry is a miss", async () => {
    const cacheDir = await dir();
    const cache = ocrCache(cacheDir, "test-provider");
    let runs = 0;
    const recognize = async () => {
      runs++;
      return [] as OcrBlock[];
    };
    expect(await cache(page, [], recognize)).toEqual([]);
    // a page with nothing on it was recognized once and must not be run again
    expect(await cache(page, [], recognize)).toEqual([]);
    expect(runs).toBe(1);

    const [file] = await readdir(cacheDir);
    await writeFile(join(cacheDir, file!), "not json at all");
    expect(await cache(page, [], recognize)).toEqual([]);
    expect(runs).toBe(2);
    await rm(cacheDir, { recursive: true, force: true });
  });

  test("a cache that cannot be written never fails the page", async () => {
    const cacheDir = await dir();
    await writeFile(join(cacheDir, "wall"), "");
    const cache = ocrCache(join(cacheDir, "wall", "pages"), "test-provider");
    expect(await cache(page, [], async () => cached)).toEqual(cached);
    await rm(cacheDir, { recursive: true, force: true });
  });
});

// OnnxTR reports raw DocLayNet classes and page-relative boxes. Everything
// below is fixture data in the exact shape `tools/ocr-onnxtr.py` emits: no
// model is loaded and no Python runs.
describe("OnnxTR normalization", () => {
  const item = (label: string, text: string, box: number[]): OnnxtrItem => ({ label, text, box });
  // boxes are subtractions of decimals: compare them at the precision a crop needs
  const round = (blocks: OcrBlock[]) =>
    blocks.map((block) => ({ ...block, ...Object.fromEntries((["x", "y", "w", "h"] as const).map((k) => [k, +block[k].toFixed(6)])) }));

  test("maps all eleven layout classes onto labels the shared mapper reads", () => {
    expect(
      Object.fromEntries(
        [
          "Caption",
          "Footnote",
          "Formula",
          "List-item",
          "Page-footer",
          "Page-header",
          "Picture",
          "Section-header",
          "Table",
          "Text",
          "Title",
        ].map((raw) => [raw, onnxtrLabel(raw, "body text")])
      )
    ).toEqual({
      Caption: "caption",
      Footnote: "footnote",
      Formula: "image",
      "List-item": "list",
      "Page-footer": "footer",
      "Page-header": "header",
      Picture: "image",
      "Section-header": "paragraph_title",
      Table: "table",
      Text: "text",
      Title: "doc_title",
    });
  });

  test("a Section-header is a heading, never a demoted running head", () => {
    const blocks = onnxtrBlocks([item("Section-header", "DOWN THE RABBIT-HOLE", [0.1, 0.08, 0.9, 0.12])], []);
    expect(round(blocks)).toEqual([
      { text: "DOWN THE RABBIT-HOLE", label: "paragraph_title", x: 0.1, y: 0.08, w: 0.8, h: 0.04 },
    ]);
    expect(ocrBlocksToBookBlocks(blocks, 3)).toEqual([
      { type: "heading", level: 2, text: "DOWN THE RABBIT-HOLE", page: 3 },
    ]);
  });

  test("a Title is the document title, a Page-header is furniture", () => {
    const blocks = onnxtrBlocks(
      [
        item("Page-header", "ALICE IN WONDERLAND", [0.3, 0.02, 0.7, 0.04]),
        item("Title", "Alice's Adventures in Wonderland", [0.1, 0.3, 0.9, 0.4]),
        item("Page-footer", "Free eBooks at Planet eBook", [0.3, 0.95, 0.7, 0.97]),
      ],
      []
    );
    expect(ocrBlocksToBookBlocks(blocks, 1)).toEqual([
      { type: "text", role: "running-header", text: "ALICE IN WONDERLAND", page: 1 },
      { type: "heading", level: 1, text: "Alice's Adventures in Wonderland", page: 1 },
      { type: "text", role: "running-footer", text: "Free eBooks at Planet eBook", page: 1 },
    ]);
  });

  test("a running head that is only a numeral is a page number", () => {
    expect(onnxtrLabel("Page-footer", " 12. ")).toBe("number");
    expect(onnxtrLabel("Page-header", "xiv")).toBe("number");
    expect(onnxtrLabel("Page-header", "Chapter 12")).toBe("header");
    expect(ocrBlocksToBookBlocks(onnxtrBlocks([item("Page-footer", "12", [0.48, 0.95, 0.52, 0.97])], []), 12)).toEqual([
      { type: "text", role: "page-number", text: "12", page: 12 },
    ]);
  });

  test("a Picture region survives as a croppable image, and is not duplicated", () => {
    const blocks = onnxtrBlocks(
      // a caption below the picture, and a stray word the recognizer read inside it
      [item("Picture", "PLATE I", [0.2, 0.2, 0.4, 0.25]), item("Caption", "The White Rabbit", [0.2, 0.62, 0.8, 0.66])],
      [item("Picture", "", [0.15, 0.15, 0.85, 0.6])]
    );
    expect(round(blocks)).toEqual([
      { text: "", label: "image", x: 0.15, y: 0.15, w: 0.7, h: 0.45 },
      { text: "The White Rabbit", label: "caption", x: 0.2, y: 0.62, w: 0.6, h: 0.04 },
    ]);
    expect(ocrFigures(blocks)).toHaveLength(1);
    // the caption sits next to the figure, so the shared mapper binds it
    expect(ocrBlocksToBookBlocks(blocks, 7)).toEqual([
      { type: "image", file: expect.stringMatching(/^assets\/fig-7-/), caption: "The White Rabbit", page: 7 },
    ]);
  });

  test("a picture is placed where it sits on the page, keeping reading order", () => {
    const blocks = onnxtrBlocks(
      [
        item("Text", "before the plate", [0.1, 0.1, 0.9, 0.15]),
        item("Text", "after the plate", [0.1, 0.7, 0.9, 0.75]),
      ],
      [item("Picture", "", [0.1, 0.2, 0.9, 0.6])]
    );
    expect(blocks.map((block) => block.label)).toEqual(["text", "image", "text"]);
  });

  test("a Formula keeps its pixels rather than inventing TeX", () => {
    const blocks = onnxtrBlocks(
      [item("Formula", "E = mc?", [0.3, 0.4, 0.7, 0.45])],
      [item("Formula", "", [0.3, 0.4, 0.7, 0.45])]
    );
    expect(round(blocks)).toEqual([{ text: "", label: "image", x: 0.3, y: 0.4, w: 0.4, h: 0.05 }]);
    expect(ocrBlocksToBookBlocks(blocks, 4)).toEqual([
      { type: "image", file: expect.stringMatching(/^assets\/fig-4-/), page: 4 },
    ]);
  });

  test("consecutive List-item regions become one list, and a wrapped item one bullet", () => {
    const blocks = onnxtrBlocks(
      [
        item("List-item", "first item", [0.1, 0.2, 0.9, 0.24]),
        item("List-item", "second item that\nwrapped over two lines", [0.1, 0.25, 0.9, 0.33]),
        item("Text", "and a paragraph after it", [0.1, 0.4, 0.9, 0.45]),
        item("List-item", "a separate later list", [0.1, 0.5, 0.9, 0.54]),
      ],
      []
    );
    expect(round(blocks)[0]).toEqual({
      text: "first item\nsecond item that wrapped over two lines",
      label: "list",
      x: 0.1,
      y: 0.2,
      w: 0.8,
      h: 0.13,
    });
    expect(ocrBlocksToBookBlocks(blocks, 5)).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "first item", page: 5 }],
          [{ type: "text", text: "second item that wrapped over two lines", page: 5 }],
        ],
        page: 5,
      },
      { type: "text", text: "and a paragraph after it", page: 5 },
      { type: "list", ordered: false, items: [[{ type: "text", text: "a separate later list", page: 5 }]], page: 5 },
    ]);
  });

  test("table cells become the HTML the shared parser already reads", () => {
    const table: OnnxtrItem = {
      label: "Table",
      box: [0.1, 0.3, 0.9, 0.5],
      rows: 2,
      cols: 2,
      cells: [
        { row_start: 0, row_end: 0, col_start: 0, col_end: 0, value: "Beasts & birds" },
        { row_start: 0, row_end: 0, col_start: 1, col_end: 1, value: "Count" },
        { row_start: 1, row_end: 1, col_start: 0, col_end: 0, value: "Dodo" },
        { row_start: 1, row_end: 1, col_start: 1, col_end: 1, value: "1" },
      ],
    };
    expect(onnxtrTableHtml(table)).toBe(
      "<table><tr><td>Beasts &amp; birds</td><td>Count</td></tr><tr><td>Dodo</td><td>1</td></tr></table>"
    );
    expect(ocrBlocksToBookBlocks(onnxtrBlocks([table], []), 9)).toEqual([
      { type: "table", rows: [["Beasts & birds", "Count"], ["Dodo", "1"]], page: 9 },
    ]);
  });

  test("a merged cell keeps its span, so the grid degrades instead of reshaping", () => {
    const table: OnnxtrItem = {
      label: "Table",
      box: [0.1, 0.3, 0.9, 0.5],
      rows: 2,
      cols: 2,
      cells: [
        { row_start: 0, row_end: 0, col_start: 0, col_end: 1, value: "Both columns" },
        { row_start: 1, row_end: 1, col_start: 0, col_end: 0, value: "Dodo" },
        { row_start: 1, row_end: 1, col_start: 1, col_end: 1, value: "1" },
      ],
    };
    expect(onnxtrTableHtml(table)).toContain('<td colspan="2">Both columns</td>');
    expect(ocrBlocksToBookBlocks(onnxtrBlocks([table], []), 9)[0]).toMatchObject({ type: "text", role: "table-source" });
  });

  test("an empty or unusable region never reaches the book", () => {
    expect(
      onnxtrBlocks(
        [
          item("Text", "   ", [0.1, 0.1, 0.9, 0.2]),
          item("Text", "zero height", [0.1, 0.3, 0.9, 0.3]),
          item("Text", "not a number", [0.1, Number.NaN, 0.9, 0.5]),
          { label: "Table", box: [0.1, 0.6, 0.9, 0.7], cells: [] },
        ],
        []
      )
    ).toEqual([]);
  });

  test("an unknown class becomes prose, never an invented heading", () => {
    expect(onnxtrLabel("Sidebar")).toBe("text");
    expect(onnxtrLabel("")).toBe("text");
  });

  test("boxes are converted, never rescaled", () => {
    // OnnxTR geometry is already relative: ((xmin,ymin),(xmax,ymax))
    expect(onnxtrBlocks([item("Text", "x", [0.125, 0.25, 0.5, 0.75])], [])[0]).toMatchObject({
      x: 0.125,
      y: 0.25,
      w: 0.375,
      h: 0.5,
    });
    // and clamped to the page rather than trusted blindly
    expect(onnxtrBlocks([item("Text", "x", [-0.1, 0, 1.4, 0.5])], [])[0]).toMatchObject({ x: 0, w: 1 });
  });

  test("the recognizer follows the requested language", () => {
    expect(onnxtrRecognizer([])).toBe("parseq");
    expect(onnxtrRecognizer(["en"])).toBe("parseq");
    expect(onnxtrRecognizer(["pt-BR"])).toBe("parseq");
    expect(onnxtrRecognizer(["ru"])).toBe("hub:Felix92/onnxtr-parseq-multilingual-v1");
    expect(onnxtrRecognizer(["cs"])).toBe("hub:Felix92/onnxtr-parseq-multilingual-v1");
  });
});
