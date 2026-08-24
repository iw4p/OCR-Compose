// Reading EPUBs we did not write (Gutenberg-style markup), reproducing the
// failures found on the first real corpus run: container nesting, cross-doc
// links, non-kebab ids, <br/>, wrapped source text, standalone images.
import { describe, expect, test } from "vitest";
import JSZip from "jszip";
import { readEpub } from "./read.js";
import { validateBook, type Block } from "../contract.js";

async function foreignEpub(chapters: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
       <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
     </container>`
  );
  const docs = Object.keys(chapters);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
         <dc:identifier id="id">x</dc:identifier><dc:title id="t">Foreign</dc:title><dc:language>en</dc:language>
         <dc:creator id="c">Anon</dc:creator>
       </metadata>
       <manifest>
         ${docs.map((d, i) => `<item id="d${i}" href="${d}" media-type="application/xhtml+xml"/>`).join("")}
         <item id="css" href="style.css" media-type="text/css"/>
         <item id="pic" href="images/pic.png" media-type="image/png"/>
       </manifest>
       <spine>${docs.map((_, i) => `<itemref idref="d${i}"/>`).join("")}</spine>
     </package>`
  );
  for (const [name, body] of Object.entries(chapters))
    zip.file(
      `OEBPS/${name}`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`
    );
  zip.file("OEBPS/style.css", "p { margin: 0 }");
  zip.file("OEBPS/images/pic.png", new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: "uint8array" });
}

describe("foreign EPUBs", () => {
  test("content nested in section/div containers is found, not dropped", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<section><div class="chapter">
          <h2 id="chap01">Chapter I</h2>
          <p>First paragraph.</p>
          <div class="inner"><p>Nested deeper.</p></div>
        </div></section>`,
      })
    );
    expect(book.content.map((b) => b.type)).toEqual(["heading", "text", "text"]);
    expect((book.content[2] as Extract<Block, { type: "text" }>).text).toBe("Nested deeper.");
  });

  test("source-wrapped prose is whitespace-normalized; <br/> becomes a space", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>
          So she was considering
          in her own <i>mind</i>,<br/>
          whether the pleasure.
        </p>`,
      })
    );
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe(
      "So she was considering in her own *mind*, whether the pleasure."
    );
  });

  test("non-kebab ids are sanitized consistently, links follow the mapping", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<h2 id="Chapter_One">One</h2><p>See <a href="#Chapter_One">chapter one</a>.</p>`,
      })
    );
    expect(book.content[0]!.id).toBe("chapter-one");
    expect((book.content[1] as Extract<Block, { type: "text" }>).text).toBe(
      "See [chapter one](#chapter-one)."
    );
    expect(validateBook(book)).toEqual([]);
  });

  test("cross-document links resolve to flat anchors; dangling ones demote to plain text", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>Go to <a href="c2.xhtml#chap02">chapter two</a> or <a href="gone.xhtml#nope">nowhere</a>.</p>`,
        "c2.xhtml": `<h2 id="chap02">Two</h2>`,
      })
    );
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe(
      "Go to [chapter two](#chap02) or nowhere."
    );
    expect(warnings.some((w) => w.includes("nope"))).toBe(true);
    expect(validateBook(book)).toEqual([]);
  });

  test("standalone img and img-only paragraphs become image blocks", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<img src="images/pic.png" alt="A picture"/><p><img src="images/pic.png"/></p>`,
      })
    );
    expect(book.content.map((b) => b.type)).toEqual(["image", "image"]);
    expect((book.content[0] as Extract<Block, { type: "image" }>).file).toBe("images/pic.png");
    expect((book.content[0] as Extract<Block, { type: "image" }>).alt).toBe("A picture");
  });

  test("list items holding bare inline content (a Gutenberg TOC) become text blocks", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<ul><li><a href="#chap01">Chapter One</a></li><li>Plain entry</li></ul>
          <div id="chap01"><h2>One</h2></div>`,
      })
    );
    const list = book.content[0] as Extract<Block, { type: "list" }>;
    expect(list.items).toEqual([
      [{ type: "text", text: "[Chapter One](#chap01)" }],
      [{ type: "text", text: "Plain entry" }],
    ]);
    expect(validateBook(book)).toEqual([]);
  });

  test("an <a> without href is an anchor, not a dangling link — no warning", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({ "c1.xhtml": `<p><a id="mark-1"></a>Some text.</p>` })
    );
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe("Some text.");
    expect(warnings).toEqual([]);
  });

  test("a container's id hoists onto its first block so links keep resolving", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>See <a href="#chap01">one</a>.</p><div class="chapter" id="chap01"><h2>One</h2></div>`,
      })
    );
    expect(book.content[1]).toMatchObject({ type: "heading", id: "chap01" });
    expect(validateBook(book)).toEqual([]);
  });

  test("an inline anchor id inside a heading becomes the heading's id (Gutenberg chapters)", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>See <a href="#chap01">chapter one</a>.</p>
          <div class="chapter" id="pgepubid00003"><h2><a id="chap01"/>CHAPTER I.<br/>Down the Rabbit-Hole</h2></div>`,
      })
    );
    expect(book.content[1]).toMatchObject({
      type: "heading",
      text: "CHAPTER I. Down the Rabbit-Hole",
    });
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toMatch(/\[chapter one\]\(#.+\)/);
    expect(warnings).toEqual([]);
    expect(validateBook(book)).toEqual([]);
  });

  test("links to every id that collapsed onto one block resolve via aliases", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>Via <a href="#wrapper-id">container</a> or <a href="#anchor-id">anchor</a>.</p>
          <div id="wrapper-id"><h2 id="own-id"><a id="anchor-id"/>Title</h2></div>`,
      })
    );
    expect(book.content[1]!.id).toBe("own-id");
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe(
      "Via [container](#own-id) or [anchor](#own-id)."
    );
    expect(warnings).toEqual([]);
    expect(validateBook(book)).toEqual([]);
  });

  test("an anchor inside a text block resolves links to that block", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<p>See <a href="#mark">the marked one</a>.</p><p><a id="mark"></a>Text.</p>`,
      })
    );
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe(
      "See [the marked one](#mark)."
    );
    expect(book.content[1]!.id).toBe("mark");
    expect(warnings).toEqual([]);
    expect(validateBook(book)).toEqual([]);
  });

  test("links whose target id does not survive as a block are demoted post-hoc", async () => {
    const { book, warnings } = await readEpub(
      await foreignEpub({
        // the target id sits in a container that yields no block at all
        "c1.xhtml": `<p>See <a href="#lost">the lost one</a>.</p><div id="lost"><hr/></div>`,
      })
    );
    expect((book.content[0] as Extract<Block, { type: "text" }>).text).toBe("See the lost one.");
    expect(warnings.some((w) => w.includes("lost"))).toBe(true);
    expect(validateBook(book)).toEqual([]);
  });

  test("links and emphasis inside table cells survive as dialect (a Gutenberg TOC table)", async () => {
    const { book } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<table><tbody><tr>
            <td> <a href="#chap01" class="pginternal">CHAPTER I.</a></td><td>Down the <i>Rabbit-Hole</i></td>
          </tr></tbody></table>
          <div id="chap01"><h2>One</h2></div>`,
      })
    );
    const table = book.content[0] as Extract<Block, { type: "table" }>;
    expect(table.rows).toEqual([["[CHAPTER I.](#chap01)", "Down the *Rabbit-Hole*"]]);
    expect(validateBook(book)).toEqual([]);
  });

  test("only referenced assets are kept; css and unknown leaves are dropped with the book still valid", async () => {
    const { book, assets } = await readEpub(
      await foreignEpub({
        "c1.xhtml": `<hr/><p>Text.</p><img src="images/pic.png"/>`,
      })
    );
    expect([...assets.keys()]).toEqual(["images/pic.png"]);
    expect(validateBook(book)).toEqual([]);
  });
});
