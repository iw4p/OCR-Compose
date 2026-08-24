import { describe, expect, test } from "vitest";
import { ocrBlocksToBookBlocks, type OcrBlock } from "./ocr.js";

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

  test("flattens internal newlines and drops empty blocks", () => {
    const output = ocrBlocksToBookBlocks(
      [
        { text: "first line\nsecond line", label: "text", x: 0, y: 0, w: 1, h: 0.2 },
        { text: "   ", label: "image", x: 0, y: 0.3, w: 1, h: 0.5 },
      ],
      1
    );
    expect(output).toEqual([{ type: "text", text: "first line second line", page: 1 }]);
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
