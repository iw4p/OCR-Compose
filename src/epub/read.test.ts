import { describe, expect, test } from "vitest";
import { writeEpub } from "./write.js";
import { readEpub } from "./read.js";
import { feldtheorie } from "../fixtures.js";
import { validateBook, type Block } from "../contract.js";

const assets = new Map<string, Uint8Array>(
  ["assets/cover.jpg", "assets/eq-2-15.png", "assets/fig-2-4.png", "assets/tab-2-2.png"].map(
    (name) => [name, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]
  )
);

const roundtrip = async (book: typeof feldtheorie) => readEpub(await writeEpub(book, assets));

describe("readEpub", () => {
  test("recovers metadata and cover", async () => {
    const { book } = await roundtrip(feldtheorie);
    expect(book.title).toBe("Feldtheorie");
    expect(book.author).toBe("K. Weiss");
    expect(book.language).toBe("de");
    expect(book.cover).toBe("assets/cover.jpg");
  });

  test("recovers assets byte-for-byte", async () => {
    const result = await roundtrip(feldtheorie);
    expect([...result.assets.keys()].sort()).toEqual([...assets.keys()].sort());
    expect([...result.assets.get("assets/fig-2-4.png")!]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("recovers headings with id and level", async () => {
    const { book } = await roundtrip(feldtheorie);
    expect(book.content[0]).toEqual({
      type: "heading",
      level: 2,
      id: "sec-2-3",
      text: "2.3 Die Lagrange-Dichte",
      page: 41,
    });
  });

  test("maps XHTML inline back to the dialect, escapes included", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "text",
      text: "**Fett** und *kursiv*, \\$5, siehe [Gl. 2.14](#eq-2-14) und [MobileRead](https://mobileread.com/)",
      page: 44,
    });
    const { book: back } = await roundtrip(book);
    expect(back.content.at(-1)).toEqual(book.content.at(-1));
  });

  test("recovers footnotes with labels and the noteref in the text", async () => {
    const { book } = await roundtrip(feldtheorie);
    expect(book.footnotes["ch2-fn7"]).toEqual({
      label: "7",
      blocks: [{ type: "text", text: "Vgl. Landau & Lifschitz, *Klassische Feldtheorie*, §2." }],
    });
    const withRef = book.content[2] as Extract<Block, { type: "text" }>;
    expect(withRef.text).toContain("[^ch2-fn7]");
  });

  test("recovers page provenance including the mid-paragraph break offset", async () => {
    const { book } = await roundtrip(feldtheorie);
    expect(book.content[1]!.page).toBe(41);
    expect(book.content[2]!.pages).toEqual([{ page: 41 }, { page: 42, at: 53 }]);
    expect(book.content[5]!.page).toBe(43);
  });

  test("the full fixture round-trips exactly", async () => {
    const { book } = await roundtrip(feldtheorie);
    expect(validateBook(book)).toEqual([]);
    expect(book).toEqual(feldtheorie);
  });

  test("block roles round-trip through the class attribute", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({ type: "text", role: "separator", text: "\\* \\* \\*", page: 44 });
    const { book: back } = await roundtrip(book);
    expect(back.content.at(-1)).toEqual(book.content.at(-1));
  });

  test("tables with rows, lists, and annotations round-trip exactly", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push(
      {
        type: "table",
        rows: [
          ["Melange", "€4.20"],
          ["Einspänner", "€4.80"],
        ],
        caption: "Preise.",
        page: 44,
      },
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "Erstens." }], [{ type: "text", text: "*Zweitens.*" }]],
        page: 44,
      },
      {
        type: "text",
        text: "Er nannte es ein Gefühl von joie de vivre, das ihm fehlte.",
        annotations: [{ start: 28, end: 41, matches: "joie de vivre", language: "fr" }],
        page: 45,
      }
    );
    const { book: back } = await roundtrip(book);
    expect(back.content.slice(-3)).toEqual(book.content.slice(-3));
  });
});
