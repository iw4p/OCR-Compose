import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { pdfToBook } from "./pdf.js";
import { extractPdf } from "./extract.js";
import { textlayer } from "./textlayer.js";
import { validateBook, type Block } from "../contract.js";
import { writeEpub } from "../epub/write.js";
import { readEpub } from "../epub/read.js";

const ALICE = "corpus/pdf/alices-adventures-in-wonderland.pdf";
const DOUBLE = "corpus/pdf/alice-doublelayer.pdf";

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
