import { describe, expect, test } from "vitest";
import { BookSchema, validateBook, type Book } from "./contract.js";
import { feldtheorie } from "./fixtures.js";

const clone = <T>(v: T): T => structuredClone(v);

describe("BookSchema shape", () => {
  test("accepts the DESIGN.md excerpt", () => {
    const result = BookSchema.safeParse(feldtheorie);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  test("rejects unknown keys (strict objects, so typos surface)", () => {
    const book = clone(feldtheorie) as Record<string, unknown>;
    book["tittle"] = "typo";
    expect(BookSchema.safeParse(book).success).toBe(false);

    const book2 = clone(feldtheorie);
    (book2.content[0] as Record<string, unknown>)["lvel"] = 3;
    expect(BookSchema.safeParse(book2).success).toBe(false);
  });

  test("rejects a block with an unknown type", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "hologram" } as never);
    expect(BookSchema.safeParse(book).success).toBe(false);
  });

  test("rejects non-kebab-case ids", () => {
    const book = clone(feldtheorie);
    (book.content[0] as { id?: string }).id = "Sec_2.3";
    expect(BookSchema.safeParse(book).success).toBe(false);
  });

  test("multi-page provenance: first entry has no `at`, later entries require it", () => {
    const book = clone(feldtheorie);
    const block = book.content[2] as Extract<Book["content"][number], { type: "text" }>;
    block.pages = [{ page: 41 }, { page: 42 } as never];
    expect(BookSchema.safeParse(book).success).toBe(false);
  });

  test("a block may not carry both `page` and `pages`", () => {
    const book = clone(feldtheorie);
    const block = book.content[1] as Record<string, unknown>;
    block["pages"] = [{ page: 41 }, { page: 42, at: 3 }];
    expect(BookSchema.safeParse(book).success).toBe(false);
  });

  test("list blocks nest blocks inside items", () => {
    const book = clone(feldtheorie);
    book.content.push({
      type: "list",
      ordered: true,
      items: [
        [{ type: "text", text: "Erstens." }],
        [{ type: "text", text: "Zweitens, mit *Nachdruck*." }],
      ],
    });
    const result = BookSchema.safeParse(book);
    expect(result.error?.issues ?? []).toEqual([]);
  });
});

describe("validateBook cross-checks", () => {
  test("the fixture validates with no issues", () => {
    expect(validateBook(feldtheorie)).toEqual([]);
  });

  test("an internal link to a nonexistent id is reported", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "text", text: "siehe [Kapitel 9](#sec-9-9)" });
    const issues = validateBook(book);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/sec-9-9/);
  });

  test("a noteref to a nonexistent footnote is reported", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "text", text: "wie gezeigt.[^ch3-fn1]" });
    expect(validateBook(book).some((i) => i.message.includes("ch3-fn1"))).toBe(true);
  });

  test("a link may target a footnote id", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "text", text: "siehe [Anmerkung 7](#ch2-fn7)" });
    expect(validateBook(book)).toEqual([]);
  });

  test("duplicate block ids are reported", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "heading", level: 2, id: "sec-2-3", text: "Nochmal" });
    expect(validateBook(book).some((i) => i.message.includes("sec-2-3"))).toBe(true);
  });

  test("invalid inline dialect in any text-bearing field is reported with its path", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "text", text: "costs $4 per unit" });
    const issues = validateBook(book);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["content", 9, "text"]);
    expect(issues[0]!.message).toMatch(/unclosed/i);
  });

  test("annotation offsets must slice to `matches` (code points, not UTF-16)", () => {
    const book = clone(feldtheorie);
    book.content.push({
      type: "text",
      text: "Er nannte es ein Gefühl von joie de vivre, das ihm fehlte.",
      annotations: [{ start: 28, end: 41, matches: "joie de vivre", language: "fr" }],
    });
    expect(validateBook(book)).toEqual([]);

    const bad = clone(book);
    const block = bad.content.at(-1) as Extract<Book["content"][number], { type: "text" }>;
    block.annotations![0]!.start = 30;
    block.annotations![0]!.end = 44;
    expect(validateBook(bad).some((i) => /matches/.test(i.message))).toBe(true);

    // astral characters: 𝜙 is one code point but two UTF-16 units
    const astral = clone(feldtheorie);
    astral.content.push({
      type: "text",
      text: "Das Feld 𝜙 ist reell.",
      annotations: [{ start: 15, end: 20, matches: "reell" }],
    });
    expect(validateBook(astral)).toEqual([]);
  });

  test("table cells carry the inline dialect and are validated like text", () => {
    const book = clone(feldtheorie);
    book.content.push({ type: "table", rows: [["fine", "costs $4"]] });
    const issues = validateBook(book);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["content", 9, "rows", 0, 1]);
  });

  test("schema failures are returned as issues, not thrown", () => {
    const issues = validateBook({ title: "", language: "de", content: [] });
    expect(issues.length).toBeGreaterThan(0);
  });
});
