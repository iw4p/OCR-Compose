import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { pdfToBook } from "./pdf.js";
import { extractPdf, renderPage } from "./extract.js";
import { textlayer } from "./textlayer.js";
import { validateBook, type Block } from "../contract.js";
import type { OcrBlock, OcrEngine } from "./ocr.js";
import { writeEpub } from "../epub/write.js";
import { readEpub } from "../epub/read.js";

const ALICE = "corpus/pdf/alices-adventures-in-wonderland.pdf";
const DOUBLE = "corpus/pdf/alice-doublelayer.pdf";
const SCAN = "corpus/pdf/alice-scan.pdf";

describe.skipIf(!existsSync(ALICE))("born-digital PDF → contract (Alice, Planet eBook)", async () => {
  const { book } = await pdfToBook(new Uint8Array(readFileSync(ALICE)), {
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    language: "en",
  });

  test("produces a valid book", () => {
    expect(validateBook(book)).toEqual([]);
    expect(book.content.length).toBeGreaterThan(300);
  });

  test("finds the twelve chapter headings", () => {
    const chapters = book.content.filter(
      (b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && /^Chapter /.test(b.text)
    );
    expect(chapters).toHaveLength(12);
    expect(chapters.every((c) => c.id !== undefined)).toBe(true);
  });

  test("strips the running footer everywhere", () => {
    const leaked = book.content.filter((b) => JSON.stringify(b).includes("Free eBooks at Planet eBook"));
    expect(leaked).toEqual([]);
  });

  test("preserves italics from the font name", () => {
    const it = book.content.find((b) => b.type === "text" && b.text.includes("finger *very* deeply"));
    expect(it).toBeDefined();
  });

  test("unwraps soft hyphens", () => {
    const joined = book.content.find((b) => b.type === "text" && /unpleasant things/.test((b as { text: string }).text));
    expect(joined).toBeDefined();
    expect(JSON.stringify(book.content)).not.toContain("­");
  });

  test("merges paragraphs across pages with break offsets", () => {
    const spanning = book.content.filter((b) => b.pages !== undefined);
    expect(spanning.length).toBeGreaterThan(20);
    for (const b of spanning.slice(0, 5)) expect(b.pages![1]!.at).toBeGreaterThan(0);
  });

  test("packs to an EPUB that reads back", async () => {
    const { assets } = await pdfToBook(new Uint8Array(readFileSync(ALICE)), { language: "en" });
    const epub = await writeEpub(book, assets);
    const { book: back } = await readEpub(epub);
    expect(back.title).toBe("Alice's Adventures in Wonderland");
    expect(back.content.length).toBe(book.content.length);
  });
});

describe.skipIf(!existsSync(DOUBLE))("double-layer PDF routing (Alice, archive.org)", () => {
  test("ignores the hidden OCR layer and requires fresh OCR", async () => {
    const bytes = new Uint8Array(readFileSync(DOUBLE));
    const { counts } = textlayer(extractPdf(bytes).pages);
    expect(counts.scanned).toBeGreaterThan(100);
    await expect(
      pdfToBook(bytes, { title: "Alice in Wonderland", language: "en" })
    ).rejects.toThrow("PaddleOCR-VL 1.6");
  });
});

// The real page-19 layout PaddleOCR-VL 1.6 returns for alice-scan.pdf, so the
// scanned path can be exercised without the optional Python dependency.
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

describe.skipIf(!existsSync(SCAN))("scanned PDF illustrations (Alice, archive.org)", () => {
  const engine = (): OcrEngine => ({ name: "stub", recognize: async () => ALICE_PAGE_19 });

  test("crops the figure region out of the page render and binds its caption", async () => {
    const bytes = new Uint8Array(readFileSync(SCAN));
    const { book, assets } = await pdfToBook(bytes, {
      title: "Alice in Wonderland",
      language: "en",
      pages: [19],
      ocr: engine(),
    });
    expect(validateBook(book)).toEqual([]);

    const image = book.content.find((block) => block.type === "image");
    expect(image).toMatchObject({
      type: "image",
      page: 19,
      caption: "She tried the little golden key in the lock.",
    });
    const png = assets.get((image as Extract<Block, { type: "image" }>).file);
    expect(png).toBeDefined();
    // a real PNG, and a crop rather than the whole page
    expect([...png!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png!.length).toBeLessThan(renderPage(bytes, 19, 3).png.length);
  });

  test("packs the cropped figure into the EPUB", async () => {
    const { book, assets } = await pdfToBook(new Uint8Array(readFileSync(SCAN)), {
      title: "Alice in Wonderland",
      language: "en",
      pages: [19],
      ocr: engine(),
    });
    const { book: back } = await readEpub(await writeEpub(book, assets));
    const image = back.content.find((block) => block.type === "image");
    expect(image).toMatchObject({ caption: "She tried the little golden key in the lock." });
  });
});

describe.skipIf(!existsSync(ALICE))("selected PDF pages", () => {
  test("retains original source-page provenance", async () => {
    const { book, report } = await pdfToBook(new Uint8Array(readFileSync(ALICE)), {
      title: "Alice excerpt",
      language: "en",
      pages: [10, 11],
    });
    expect(report.pages.map((page) => page.page)).toEqual([10, 11]);
    const provenance = book.content.flatMap((block) =>
      block.page !== undefined ? [block.page] : (block.pages ?? []).map((page) => page.page)
    );
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.every((page) => page === 10 || page === 11)).toBe(true);
  });
});
