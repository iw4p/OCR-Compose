import { describe, expect, test } from "vitest";
import type { PdfLine, PdfPage } from "./extract.js";
import { classify, unwrap, detectHeadings } from "./passes.js";

// -- helpers to build synthetic pages ---------------------------------------
let Y = 0;
function line(
  text: string,
  opts: { x?: number; y?: number; size?: number; italicRanges?: [number, number][]; page?: number } = {}
): PdfLine {
  const { x = 41, size = 10, page = 1 } = opts;
  const y = opts.y ?? (Y += 12);
  const runs = [];
  let pos = 0;
  const cuts = (opts.italicRanges ?? []).flat().concat(text.length);
  let italic = false;
  for (const cut of cuts) {
    if (cut > pos)
      runs.push({ text: text.slice(pos, cut), font: italic ? "F-It" : "F", size, italic, bold: false, x: x + pos * 5, y, w: (cut - pos) * 5, h: size });
    pos = cut;
    italic = !italic;
  }
  return { runs, x, y, w: text.length * 5, h: size, page };
}
function mkPage(lines: PdfLine[], page = 1): PdfPage {
  return { page, width: 322, height: 484, lines: lines.map((l) => ({ ...l, page })), imageCoverage: 0, fonts: new Set(["F"]) };
}
const body = (p: PdfPage) => p.lines.filter((l) => !l.role);

describe("classify", () => {
  test("repeating footers with page numbers are marked and printed pages captured", () => {
    const texts = [
      "Alice was beginning to get very tired of sitting.",
      "There was nothing so very remarkable in that.",
      "The rabbit-hole went straight on like a tunnel.",
      "Either the well was very deep, or she fell slowly.",
    ];
    const pages = [1, 2, 3, 4].map((n) => {
      Y = 40;
      return mkPage(
        [line(texts[n - 1]!), line(`${n + 8} Free eBooks at Planet eBook.com`, { y: 410, size: 7 })],
        n
      );
    });
    const { printedPages } = classify(pages);
    for (const p of pages) {
      expect(p.lines[1]!.role).toBe("furniture");
      expect(p.lines[0]!.role).toBeUndefined();
    }
    expect(printedPages.get(1)).toBe(9);
    expect(printedPages.get(4)).toBe(12);
  });

  test("all-caps running heads repeating on a few pages are furniture even in long books", () => {
    // 20-page book, chapter head repeats on 4 pages: under the 30% global
    // threshold, but all-caps zone lines use the absolute threshold of 3
    const pages = Array.from({ length: 20 }, (_, i) => {
      Y = 40;
      const lines = [line(`Body prose number ${i} with its own unique words here.`, { y: 200 })];
      if (i < 4) lines.unshift(line("DOWN THE RABBIT-HOLE", { y: 30, size: 8 }));
      if (i === 10) lines.unshift(line("ANOTHER UNIQUE CAPS LINE", { y: 30, size: 8 }));
      return mkPage(lines, i + 1);
    });
    classify(pages);
    expect(pages[0]!.lines[0]!.role).toBe("furniture");
    expect(pages[10]!.lines[0]!.role).toBeUndefined(); // appears once — kept
  });

  test("non-repeating bottom lines stay body text", () => {
    Y = 40;
    const pages = [mkPage([line("Unique closing line of the chapter.", { y: 410 })], 1)];
    classify(pages);
    expect(pages[0]!.lines[0]!.role).toBeUndefined();
  });
});

describe("unwrap", () => {
  test("indented lines start new paragraphs; wrapped lines join with spaces", () => {
    Y = 40;
    const page = mkPage([
      line("rules their friends had taught them: such as, that"),
      line("you, sooner or later."),
      line("However, this bottle was not marked, so Alice", { x: 53 }),
      line("ventured to taste it."),
    ]);
    const paras = unwrap([page], new Map());
    expect(paras.map((p) => p.text)).toEqual([
      "rules their friends had taught them: such as, that you, sooner or later.",
      "However, this bottle was not marked, so Alice ventured to taste it.",
    ]);
  });

  test("italic runs become *em*, boundary spaces kept outside the markers", () => {
    Y = 40;
    // "cut your finger very deeply" with "very " italic (trailing space inside the run)
    const page = mkPage([line("cut your finger very deeply", { italicRanges: [[16, 21]] })]);
    const paras = unwrap([page], new Map());
    expect(paras[0]!.text).toBe("cut your finger *very* deeply");
  });

  test("soft hyphen at line end joins without a space or hyphen", () => {
    Y = 40;
    const page = mkPage([line("and other unpleas­"), line("ant things happened.")]);
    const paras = unwrap([page], new Map());
    expect(paras[0]!.text).toBe("and other unpleasant things happened.");
  });

  test("ASCII hyphen: removed for wrapped words, kept when the compound appears elsewhere", () => {
    Y = 40;
    const page = mkPage([
      line("she held the red-hot poker firmly and consid-"),
      line("ered her options for the red-"),
      line("hot morning ahead."),
    ]);
    const paras = unwrap([page], new Map());
    expect(paras[0]!.text).toBe(
      "she held the red-hot poker firmly and considered her options for the red-hot morning ahead."
    );
  });

  test("italic runs continuing across a line break merge into one em — soft hyphens included", () => {
    Y = 40;
    const page = mkPage([
      line("she made some tarts, All on a sum­", { italicRanges: [[0, 34]] }),
      line("mer day: The Knave of Hearts stole", { italicRanges: [[0, 34]] }),
    ]);
    const paras = unwrap([page], new Map());
    expect(paras[0]!.text).toBe("*she made some tarts, All on a summer day: The Knave of Hearts stole*");
  });

  test("cross-page merge records the printed-page break offset (§4.4)", () => {
    // the interrupted line sits near the page bottom, as a real page break does
    const p1 = mkPage([line("The paragraph begins here and", { y: 430 })], 1);
    Y = 40;
    const p2 = mkPage([line("continues on the next page.", { page: 2 })], 2);
    const paras = unwrap(
      [p1, p2],
      new Map([
        [1, 30],
        [2, 31],
      ])
    );
    expect(paras).toHaveLength(1);
    expect(paras[0]!.text).toBe("The paragraph begins here and continues on the next page.");
    expect(paras[0]!.pages).toEqual([{ page: 30 }, { page: 31, at: 30 }]);
  });

  test("dialect specials in extracted text are escaped", () => {
    Y = 40;
    const page = mkPage([line("* * * * * and the price was $5 [sic]")]);
    const paras = unwrap([page], new Map());
    expect(paras[0]!.text).toBe("\\* \\* \\* \\* \\* and the price was \\$5 \\[sic\\]");
  });
});

describe("detectHeadings", () => {
  test("a chapter number and its title merge into one heading", () => {
    Y = 40;
    const page = mkPage([
      line("Chapter I.", { size: 20 }),
      line("Down the Rabbit-Hole", { size: 14, y: 80 }),
      line("Alice was beginning to get very tired of sitting.", { y: 120 }),
    ]);
    const blocks = detectHeadings(unwrap([page], new Map()), 10);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "Chapter I. Down the Rabbit-Hole" });
  });

  test("a title wrapped over two lines merges into one heading", () => {
    Y = 40;
    const page = mkPage([
      line("A Caucus-Race and", { size: 14 }),
      line("a Long Tale", { size: 14, y: 60 }),
      line("They were indeed a queer-looking party.", { y: 100 }),
    ]);
    const blocks = detectHeadings(unwrap([page], new Map()), 10);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "heading", text: "A Caucus-Race and a Long Tale" });
  });

  test("headings on different pages do not merge", () => {
    Y = 40;
    const p1 = mkPage([line("Chapter I.", { size: 20 })], 1);
    Y = 40;
    const p2 = mkPage([line("Chapter II.", { size: 20, page: 2 })], 2);
    const blocks = detectHeadings(unwrap([p1, p2], new Map()), 10);
    expect(blocks).toHaveLength(2);
  });

  test("drop caps are absorbed into the following paragraph, not made headings", () => {
    Y = 40;
    const page = mkPage([
      line("Chapter I.", { size: 20 }),
      line("A", { size: 31, y: 100 }),
      line("lice was beginning to get very tired of sitting", { y: 104 }),
      line("by her sister on the bank.", { y: 116 }),
    ]);
    const paras = unwrap([page], new Map());
    const blocks = detectHeadings(paras, 10);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "Chapter I." });
    expect(blocks[1]).toMatchObject({
      kind: "paragraph",
      text: "Alice was beginning to get very tired of sitting by her sister on the bank.",
    });
  });

  test("lines well above body size become headings, leveled by size rank", () => {
    Y = 40;
    const p1 = mkPage([
      line("BOOK ONE", { size: 20 }),
      line("The story begins with plenty of ordinary prose."),
    ], 1);
    Y = 40;
    const p2 = mkPage([
      line("Chapter I.", { size: 14, page: 2 }),
      line("Alice was beginning to get very tired of sitting.", { page: 2 }),
    ], 2);
    const blocks = detectHeadings(unwrap([p1, p2], new Map()), 10);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "BOOK ONE" });
    expect(blocks[2]).toMatchObject({ kind: "heading", level: 2, text: "Chapter I." });
    expect(blocks[3]).toMatchObject({ kind: "paragraph" });
  });
});
