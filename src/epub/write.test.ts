import { describe, expect, test } from "vitest";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { writeEpub } from "./write.js";
import { feldtheorie } from "../fixtures.js";

const assets = new Map<string, Uint8Array>(
  ["assets/cover.jpg", "assets/eq-2-15.png", "assets/fig-2-4.png", "assets/tab-2-2.png"].map(
    (name) => [name, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]
  )
);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

async function navOf(book: typeof feldtheorie): Promise<string> {
  const zip = await JSZip.loadAsync(await writeEpub(book, assets));
  return zip.file("OEBPS/nav.xhtml")!.async("string");
}

/** A book that is nothing but headings at the given levels. */
const headingBook = (levels: number[]): typeof feldtheorie => ({
  ...structuredClone(feldtheorie),
  content: levels.map((level, i) => ({ type: "heading", level, id: `h-${i}`, text: `Kapitel ${i}` })),
});

/** The toc as nested `[id, children?]` pairs, so nesting is asserted as data. */
function tocOutline(nav: string): unknown[] {
  const navs = [xml.parse(nav).html.body.nav].flat();
  const toc = navs.find((n) => n["@epub:type"] === "toc");
  const walk = (list: Record<string, any>): unknown[] =>
    [list.li].flat().map((li) => [String(li.a["@href"]).split("#")[1], ...(li.ol ? [walk(li.ol)] : [])]);
  return toc.ol ? walk(toc.ol) : [];
}

describe("EPUB container structure", () => {
  test("mimetype is the first entry, stored uncompressed", async () => {
    const bytes = await writeEpub(feldtheorie, assets);
    // stored-first mimetype: local header (30 bytes) + name, then plain content
    const head = Buffer.from(bytes.slice(0, 100)).toString("latin1");
    expect(head).toContain("mimetypeapplication/epub+zip");
  });

  test("container.xml points at the package document", async () => {
    const zip = await JSZip.loadAsync(await writeEpub(feldtheorie, assets));
    const container = xml.parse(await zip.file("META-INF/container.xml")!.async("string"));
    expect(container.container.rootfiles.rootfile["@full-path"]).toBe("OEBPS/package.opf");
    expect(container.container.rootfiles.rootfile["@media-type"]).toBe("application/oebps-package+xml");
  });

  test("package.opf carries metadata, manifest (incl. every asset), spine, nav", async () => {
    const zip = await JSZip.loadAsync(await writeEpub(feldtheorie, assets));
    const opf = xml.parse(await zip.file("OEBPS/package.opf")!.async("string"));
    const pkg = opf.package;
    expect(pkg["@version"]).toBe("3.0");
    expect(pkg.metadata["dc:title"]).toBe("Feldtheorie");
    expect(pkg.metadata["dc:language"]).toBe("de");
    expect(pkg.metadata["dc:creator"]).toBe("K. Weiss");

    const items: Record<string, string>[] = pkg.manifest.item;
    const hrefs = items.map((i) => i["@href"]);
    expect(hrefs).toContain("nav.xhtml");
    expect(hrefs).toContain("text/body.xhtml");
    for (const name of assets.keys()) expect(hrefs).toContain(name);
    expect(items.find((i) => i["@href"] === "nav.xhtml")!["@properties"]).toBe("nav");
    expect(items.find((i) => i["@href"] === "assets/cover.jpg")!["@properties"]).toBe("cover-image");

    expect(pkg.spine.itemref["@idref"]).toBe(items.find((i) => i["@href"] === "text/body.xhtml")!["@id"]);
  });

  test("every generated document is well-formed XML", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push(
      { type: "heading", level: 1, id: "part-1", text: "**Erster Teil**" },
      { type: "text", role: "running-header", text: "FELDTHEORIE", page: 46 },
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "Erstens." }], [{ type: "text", text: "*Zweitens.*" }]],
      },
      { type: "table", rows: [["Melange", "€4.20"]], caption: "Preise." },
      { type: "quote", text: "Zitat.", attribution: "N. N." },
      {
        type: "text",
        text: "Er nannte es joie de vivre.",
        annotations: [{ start: 13, end: 26, matches: "joie de vivre", language: "fr" }],
      }
    );
    const zip = await JSZip.loadAsync(await writeEpub(book, assets));
    for (const name of ["META-INF/container.xml", "OEBPS/package.opf", "OEBPS/nav.xhtml", "OEBPS/text/body.xhtml"])
      expect(XMLValidator.validate(await zip.file(name)!.async("string")), name).toBe(true);
  });

  test("nav.xhtml has a toc built from headings, targeting body anchors", async () => {
    const zip = await JSZip.loadAsync(await writeEpub(feldtheorie, assets));
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('href="text/body.xhtml#sec-2-3"');
    expect(nav).toContain("2.3 Die Lagrange-Dichte");
  });

  test("nav labels are plain text (dialect markup stripped) and nested by level", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push(
      { type: "heading", level: 1, id: "part-1", text: "**Erster Teil**" },
      { type: "heading", level: 2, id: "kap-1", text: "Kapitel *eins*" },
      { type: "heading", level: 2, id: "kap-2", text: "Kapitel zwei" },
      { type: "heading", level: 6, id: "junk", text: "not in the menu" }
    );
    const zip = await JSZip.loadAsync(await writeEpub(book, assets));
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain(">Erster Teil</a>");
    expect(nav).toContain(">Kapitel eins</a>");
    expect(nav).not.toContain("**");
    // kap-1 nests under part-1
    expect(nav).toMatch(/part-1[\s\S]*<ol>[\s\S]*kap-1[\s\S]*kap-2[\s\S]*<\/ol>/);
    // headings deeper than level 3 stay out of the menu
    expect(nav).not.toContain("#junk");
  });

  // One misnested list makes the whole document unparseable, so the TOC is
  // checked with a real XML validator rather than by string matching.
  test("nav.xhtml is well-formed XML whatever levels the headings use", async () => {
    const shapes = [
      [2], // the DESIGN.md §4 fixture: shallowest heading is h2
      [2, 2, 3, 2], // h2-first with a subsection
      [1, 3, 3, 1], // a legitimate h1 → h3 jump
      [1, 2, 2, 1, 2], // an ordinary h1/h2 book
      [1, 2, 3, 1], // climbing back out two levels at once
      [3, 1, 3], // deepest heading first
    ];
    for (const levels of shapes) {
      const nav = await navOf(headingBook(levels));
      expect(XMLValidator.validate(nav), `levels ${JSON.stringify(levels)}`).toBe(true);
    }
    expect(XMLValidator.validate(await navOf(feldtheorie))).toBe(true);
  });

  test("heading levels nest relatively: h2-first starts at the top, h1 → h3 descends one step", async () => {
    // the fixture's lone h2 is the top level, not a third-level orphan
    expect(tocOutline(await navOf(headingBook([2])))).toEqual([["h-0"]]);
    // h3s under an h1 with no h2 between them are that h1's children
    expect(tocOutline(await navOf(headingBook([1, 3, 3, 1])))).toEqual([
      ["h-0", [["h-1"], ["h-2"]]],
      ["h-3"],
    ]);
    expect(tocOutline(await navOf(headingBook([1, 2, 2, 1, 2])))).toEqual([
      ["h-0", [["h-1"], ["h-2"]]],
      ["h-3", [["h-4"]]],
    ]);
    // a deeper heading before a shallower one does not swallow it
    expect(tocOutline(await navOf(headingBook([3, 1, 3])))).toEqual([["h-0"], ["h-1", [["h-2"]]]]);
  });

  test("a book with no navigable heading still gets a toc pointing at the spine", async () => {
    const nav = await navOf(headingBook([]));
    expect(XMLValidator.validate(nav)).toBe(true);
    // an EPUB3 toc nav must hold a non-empty <ol>, so the book itself is the entry
    expect(nav).toContain('<li><a href="text/body.xhtml">Feldtheorie</a></li>');
  });

  test("the EPUB ships a stylesheet and block roles become classes", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({ type: "text", role: "separator", text: "\\* \\* \\*" });
    const zip = await JSZip.loadAsync(await writeEpub(book, assets));
    const css = await zip.file("OEBPS/style.css")!.async("string");
    expect(css).toContain(".role-separator");
    expect(css).toMatch(/p\s*\{[^}]*text-indent/);
    const body = await zip.file("OEBPS/text/body.xhtml")!.async("string");
    expect(body).toContain('<link rel="stylesheet" type="text/css" href="../style.css"/>');
    expect(body).toContain('<p class="role-separator">* * *</p>');
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(opf).toContain('href="style.css" media-type="text/css"');
  });

  test("asset bytes land in the zip verbatim", async () => {
    const zip = await JSZip.loadAsync(await writeEpub(feldtheorie, assets));
    const img = await zip.file("OEBPS/assets/fig-2-4.png")!.async("uint8array");
    expect([...img]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("a referenced asset missing from the map is an error", async () => {
    await expect(writeEpub(feldtheorie, new Map())).rejects.toThrow(/cover\.jpg/);
  });
});

async function bodyOf(book: typeof feldtheorie): Promise<string> {
  const zip = await JSZip.loadAsync(await writeEpub(book, assets));
  return zip.file("OEBPS/text/body.xhtml")!.async("string");
}

describe("block rendering", () => {
  test("inline dialect maps to XHTML: em, strong, links, escaped literals", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "text",
      text: "**Fett** und *kursiv*, \\$5, siehe [Gl. 2.14](#eq-2-14) und [MobileRead](https://mobileread.com/)",
    });
    const body = await bodyOf(book);
    expect(body).toContain(
      "<strong>Fett</strong> und <em>kursiv</em>, $5, " +
        'siehe <a href="#eq-2-14">Gl. 2.14</a> und <a href="https://mobileread.com/">MobileRead</a>'
    );
  });

  test("noteref becomes an epub:type link; footnote becomes an aside", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toContain('<a epub:type="noteref" href="#ch2-fn7"><sup>7</sup></a>');
    expect(body).toMatch(/<aside id="ch2-fn7" epub:type="footnote">[\s\S]*Landau &amp; Lifschitz/);
    expect(body).toContain("<em>Klassische Feldtheorie</em>");
  });

  test("quote renders as blockquote with cite attribution and language", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(
      /<blockquote xml:lang="fr" lang="fr">\s*<p>Le principe de moindre action[\s\S]*<\/p>\s*<footer><cite>Maupertuis<\/cite><\/footer>\s*<\/blockquote>/
    );
  });

  test("image renders as figure with figcaption", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(
      /<figure>\s*<img src="\.\.\/assets\/fig-2-4\.png" alt=""\/>\s*<figcaption>Feldkonfiguration mit stationärer Wirkung\.<\/figcaption>\s*<\/figure>/
    );
  });

  test("fidelity rule: rows present renders a real table, rows null falls back to figure", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "table",
      rows: [
        ["Melange", "€4.20"],
        ["Einspänner", "€4.80"],
      ],
      caption: "Preise.",
    });
    const body = await bodyOf(book);
    // rows: null → figure fallback
    expect(body).toMatch(/<figure>\s*<img src="\.\.\/assets\/tab-2-2\.png"[^>]*\/>\s*<figcaption>Kopplungskonstanten\.<\/figcaption>\s*<\/figure>/);
    // rows present → real table
    expect(body).toMatch(
      /<table>\s*<caption>Preise\.<\/caption>\s*<tr>\s*<td>Melange<\/td>\s*<td>€4.20<\/td>\s*<\/tr>[\s\S]*<\/table>/
    );
  });

  test("table cells render their inline dialect", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "table",
      rows: [["*Melange*", "[Gl. 2.14](#eq-2-14)"]],
    });
    const body = await bodyOf(book);
    expect(body).toContain("<td><em>Melange</em></td>");
    expect(body).toContain('<td><a href="#eq-2-14">Gl. 2.14</a></td>');
  });

  test("fidelity rule: tex present renders MathML with TeX annotation, tex null falls back to image", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(
      /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML" display="block">[\s\S]*<annotation encoding="application\/x-tex">S\[\\phi\] = \\int/
    );
    expect(body).toMatch(/<img src="\.\.\/assets\/eq-2-15\.png"/);
  });

  test("inline math renders as inline MathML", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(/Wirkung <math xmlns="[^"]+"><semantics>[\s\S]*x-tex">S<\/annotation>/);
  });

  test("lists render items with nested blocks", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "list",
      ordered: true,
      items: [[{ type: "text", text: "Erstens." }], [{ type: "text", text: "*Zweitens.*" }]],
    });
    const body = await bodyOf(book);
    expect(body).toMatch(/<ol>\s*<li><p>Erstens\.<\/p><\/li>\s*<li><p><em>Zweitens\.<\/em><\/p><\/li>\s*<\/ol>/);
  });

  test("pagebreak spans mark each page's first occurrence, before the owning block", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(
      /<span epub:type="pagebreak" id="page-41" role="doc-pagebreak" aria-label="41"\/>\s*<h2 id="sec-2-3">/
    );
    expect(body).toMatch(/<span epub:type="pagebreak" id="page-43"[^/]*\/>\s*<blockquote/);
    // each page id exactly once
    for (const p of [41, 42, 43, 44])
      expect(body.split(`id="page-${p}"`).length).toBe(2);
  });

  test("a mid-paragraph break offset places the span inside the paragraph at the exact point", async () => {
    const body = await bodyOf(feldtheorie);
    expect(body).toMatch(
      /<\/math> <span epub:type="pagebreak" id="page-42" role="doc-pagebreak" aria-label="42"\/>durch das Feld/
    );
  });

  test("a break offset inside an atomic construct clamps to the construct start", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "text",
      // offset 8 falls inside $a+b$ (spans 5..10) → clamp to 5, before the math
      text: "Term $a+b$ Ende",
      pages: [{ page: 90 }, { page: 91, at: 8 }],
    });
    const body = await bodyOf(book);
    expect(body).toMatch(/Term <span epub:type="pagebreak" id="page-91"[^/]*\/><math/);
  });

  test("nav.xhtml carries a page-list targeting the spans", async () => {
    const zip = await JSZip.loadAsync(await writeEpub(feldtheorie, assets));
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('epub:type="page-list"');
    for (const p of [41, 42, 43, 44]) expect(nav).toContain(`href="text/body.xhtml#page-${p}">${p}<`);
  });

  // I3 — demoted blocks are emitted, not skipped; `hidden` is what keeps the
  // running head off the page while the block survives the round-trip.
  test("demoted roles render hidden and never as visible body text", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push(
      { type: "text", role: "running-header", text: "FELDTHEORIE", page: 46 },
      { type: "text", role: "page-number", text: "46", page: 46 },
      { type: "heading", level: 2, role: "artifact", id: "scan-noise", text: "Bibliothek Wien", page: 46 },
      { type: "text", role: "separator", text: "\\* \\* \\*", page: 46 }
    );
    const zip = await JSZip.loadAsync(await writeEpub(book, assets));
    const body = await zip.file("OEBPS/text/body.xhtml")!.async("string");
    expect(body).toContain('<p class="role-running-header" hidden="hidden">FELDTHEORIE</p>');
    expect(body).toContain('<p class="role-page-number" hidden="hidden">46</p>');
    expect(body).toContain('<h2 id="scan-noise" class="role-artifact" hidden="hidden">');
    // strip every hidden element: no demoted text is left anywhere visible
    const visible = body.replace(/<(\w+)[^>]*\shidden="hidden"[^>]*>[\s\S]*?<\/\1>/g, "");
    expect(visible).not.toContain("FELDTHEORIE");
    expect(visible).not.toContain("Bibliothek Wien");
    // a role that is visible semantics keeps rendering
    expect(visible).toContain('<p class="role-separator">* * *</p>');
    // still well-formed XML, and hidden stated in CSS too (incomplete UA sheets)
    expect(XMLValidator.validate(body)).toBe(true);
    expect(await zip.file("OEBPS/style.css")!.async("string")).toContain("[hidden] { display: none; }");
    // a demoted heading is furniture, not navigation
    expect(await zip.file("OEBPS/nav.xhtml")!.async("string")).not.toContain("#scan-noise");
  });

  test("annotations render language and small-caps spans", async () => {
    const book = structuredClone(feldtheorie);
    book.content.push({
      type: "text",
      text: "Er nannte es ein Gefühl von joie de vivre, das ihm fehlte.",
      annotations: [{ start: 28, end: 41, matches: "joie de vivre", language: "fr" }],
    });
    const body = await bodyOf(book);
    expect(body).toContain('von <span xml:lang="fr" lang="fr">joie de vivre</span>, das');
  });
});
