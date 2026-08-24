// Contract → EPUB3 (DESIGN.md tool 15). Single reflowable spine document for
// v1; nav doc built from heading blocks; assets carried verbatim.
import JSZip from "jszip";
import type { Block, Book } from "../contract.js";
import { walkBlocks } from "../contract.js";
import { parseInline, renderInline, type InlineNode } from "../inline.js";

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
  css: "text/css",
};
const mediaType = (path: string) => {
  const ext = path.split(".").at(-1)!.toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`no media type known for asset "${path}"`);
  return type;
};

/** Every asset path the book references (cover + image/file fields). */
function referencedAssets(book: Book): string[] {
  const paths = new Set<string>();
  if (book.cover) paths.add(book.cover);
  for (const { block } of walkBlocks(book)) {
    if ("file" in block) paths.add(block.file);
    if ("image" in block && block.image !== undefined) paths.add(block.image);
  }
  return [...paths];
}

type RenderCtx = { footnotes: Book["footnotes"]; breaks?: { at: number; page: number }[] };

// §4.4 — a pagebreak marker carried through inline content. Zero raw width;
// rendered as the EPUB pagebreak span so the page-list can anchor mid-block.
type RNode = InlineNode | { kind: "pagebreak"; page: number };

const pageSpan = (page: number) =>
  `<span epub:type="pagebreak" id="page-${page}" role="doc-pagebreak" aria-label="${page}"/>`;

/** Raw code-point width of a node in dialect source form (markup counted). */
const nodeWidth = (node: RNode): number =>
  node.kind === "pagebreak" ? 0 : [...renderInline([node])].length;

const isSpecial = (c: string) => /[\\*$[\]^]/.test(c);

/**
 * Insert a pagebreak marker at raw offset `offset` (code points into the
 * dialect source, §4.4). Recurses into em/strong/link children; splits text
 * nodes, clamping to a character boundary if the offset falls inside an
 * escape pair; clamps to the construct start when the offset falls inside an
 * atom (math, noteref) or a delimiter.
 */
function injectMarker(nodes: RNode[], offset: number, page: number): RNode[] {
  const out: RNode[] = [];
  const marker: RNode = { kind: "pagebreak", page };
  let pos = 0;
  let placed = false;
  for (const node of nodes) {
    if (!placed && offset <= pos) {
      out.push(marker);
      placed = true;
    }
    const w = nodeWidth(node);
    if (!placed && offset < pos + w) {
      placed = true;
      if (node.kind === "text") {
        // map the raw offset to an index into the unescaped text
        let raw = pos;
        let idx = 0;
        const chars = [...node.text];
        while (idx < chars.length && raw + (isSpecial(chars[idx]!) ? 2 : 1) <= offset) {
          raw += isSpecial(chars[idx]!) ? 2 : 1;
          idx++;
        }
        const before = chars.slice(0, idx).join("");
        const after = chars.slice(idx).join("");
        if (before) out.push({ kind: "text", text: before });
        out.push(marker);
        if (after) out.push({ kind: "text", text: after });
      } else if (node.kind === "em" || node.kind === "strong" || node.kind === "link") {
        const prefix = node.kind === "em" ? 1 : node.kind === "strong" ? 2 : 1;
        const childrenWidth = node.children.reduce((n, c) => n + nodeWidth(c), 0);
        const rel = offset - pos - prefix;
        if (rel >= 0 && rel <= childrenWidth) {
          out.push({ ...node, children: injectMarker(node.children, rel, page) as InlineNode[] });
        } else {
          // inside a delimiter or a link target: clamp to construct start
          out.push(marker, node);
        }
      } else {
        // atom (math, noteref): clamp to construct start
        out.push(marker, node);
      }
    } else {
      out.push(node);
    }
    pos += w;
  }
  if (!placed) out.push(marker);
  return out;
}

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// TeX is carried losslessly as an application/x-tex annotation with the raw
// TeX as mtext fallback; real TeX→MathML conversion is the later `mathpass`.
const mathml = (tex: string, display: boolean) =>
  `<math xmlns="${MATHML_NS}"${display ? ' display="block"' : ""}><semantics><mrow><mtext>${escapeXml(
    tex
  )}</mtext></mrow><annotation encoding="application/x-tex">${escapeXml(tex)}</annotation></semantics></math>`;

function renderInlineHtml(nodes: RNode[], ctx: RenderCtx): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeXml(node.text);
        break;
      case "pagebreak":
        out += pageSpan(node.page);
        break;
      case "em":
        out += `<em>${renderInlineHtml(node.children, ctx)}</em>`;
        break;
      case "strong":
        out += `<strong>${renderInlineHtml(node.children, ctx)}</strong>`;
        break;
      case "math":
        out += mathml(node.tex, false);
        break;
      case "noteref": {
        const label = ctx.footnotes[node.id]?.label ?? "?";
        out += `<a epub:type="noteref" href="#${escapeXml(node.id)}"><sup>${escapeXml(label)}</sup></a>`;
        break;
      }
      case "link":
        out +=
          node.target.kind === "internal"
            ? `<a href="#${escapeXml(node.target.id)}">${renderInlineHtml(node.children, ctx)}</a>`
            : `<a href="${escapeXml(node.target.url)}">${renderInlineHtml(node.children, ctx)}</a>`;
        break;
    }
  }
  return out;
}

/**
 * Render a text string with its annotations (§4.5). Offsets are code points
 * into the raw string, so the string is split at annotation boundaries and
 * each segment must be independently valid dialect — an annotation that cuts
 * through a construct is an error.
 */
function renderText(block: { text: string } & Block, ctx: RenderCtx): string {
  const annotations = [...(block.annotations ?? [])].sort((a, b) => a.start - b.start);
  if (annotations.length === 0) {
    let nodes: RNode[] = parseInline(block.text);
    for (const brk of ctx.breaks ?? []) nodes = injectMarker(nodes, brk.at, brk.page);
    return renderInlineHtml(nodes, ctx);
  }
  const cp = [...block.text];
  let out = "";
  let pos = 0;
  const renderSegment = (from: number, to: number) => {
    const raw = cp.slice(from, to).join("");
    try {
      return renderInlineHtml(parseInline(raw), ctx);
    } catch (e) {
      throw new Error(`annotation boundary cuts through an inline construct at [${from}, ${to}): ${String(e)}`);
    }
  };
  for (const ann of annotations) {
    out += renderSegment(pos, ann.start);
    const attrs = [
      ann.language ? ` xml:lang="${escapeXml(ann.language)}" lang="${escapeXml(ann.language)}"` : "",
      ann.style === "small-caps" ? ` class="small-caps"` : "",
    ].join("");
    out += `<span${attrs}>${renderSegment(ann.start, ann.end)}</span>`;
    pos = ann.end;
  }
  out += renderSegment(pos, cp.length);
  return out;
}

function blockAttrs(block: Block): string {
  const id = block.id ? ` id="${escapeXml(block.id)}"` : "";
  const lang = block.language
    ? ` xml:lang="${escapeXml(block.language)}" lang="${escapeXml(block.language)}"`
    : "";
  // roles ride in a prefixed class so foreign classes can't masquerade as
  // roles on the way back in (read.ts maps only `role-*` classes)
  const role = block.role ? ` class="role-${escapeXml(block.role)}"` : "";
  return id + role + lang;
}

// Fallback figures mark their origin block type on the img class so
// `epub-read` can reconstruct table/formula blocks (fidelity levels, §3.3).
const figure = (
  src: string,
  opts: { caption?: string; alt?: string; imgClass?: string; attrs?: string; data?: Record<string, string> }
) => {
  const cls = opts.imgClass ? ` class="${opts.imgClass}"` : "";
  const data = Object.entries(opts.data ?? {})
    .map(([k, v]) => ` data-${k}="${escapeXml(v)}"`)
    .join("");
  const caption = opts.caption !== undefined ? `\n<figcaption>${escapeXml(opts.caption)}</figcaption>` : "";
  return `<figure${opts.attrs ?? ""}>\n<img src="../${escapeXml(src)}" alt="${escapeXml(opts.alt ?? "")}"${cls}${data}/>${caption}\n</figure>`;
};

function renderBlock(block: Block, ctx: RenderCtx): string {
  const attrs = blockAttrs(block);
  switch (block.type) {
    case "heading": {
      const h = Math.min(block.level, 6);
      return `<h${h}${attrs}>${renderText(block, ctx)}</h${h}>`;
    }
    case "text":
      return `<p${attrs}>${renderText(block, ctx)}</p>`;
    case "quote": {
      const cite = block.attribution
        ? `\n<footer><cite>${escapeXml(block.attribution)}</cite></footer>`
        : "";
      return `<blockquote${attrs}>\n<p>${renderText(block, ctx)}</p>${cite}\n</blockquote>`;
    }
    case "image":
      return figure(block.file, {
        ...(block.caption !== undefined && { caption: block.caption }),
        ...(block.alt !== undefined && { alt: block.alt }),
        attrs,
      });
    case "table": {
      if (block.rows === null) {
        if (!block.image) throw new Error("table block needs rows or an image");
        return figure(block.image, {
          ...(block.caption !== undefined && { caption: block.caption }),
          imgClass: "table",
          attrs,
          ...(block.scanned && { data: { scanned: "true" } }),
        });
      }
      const caption = block.caption !== undefined ? `\n<caption>${escapeXml(block.caption)}</caption>` : "";
      const rows = block.rows
        .map(
          (row) =>
            `<tr>\n${row
              .map((cell) => `<td>${renderInlineHtml(parseInline(cell), ctx)}</td>`)
              .join("\n")}\n</tr>`
        )
        .join("\n");
      return `<table${attrs}>${caption}\n${rows}\n</table>`;
    }
    case "formula": {
      if (block.tex === null) {
        if (!block.image) throw new Error("formula block needs tex or an image");
        return figure(block.image, {
          imgClass: "formula",
          attrs,
          ...(block.note !== undefined && { data: { note: block.note } }),
        });
      }
      const number =
        block.number !== undefined ? `\n<span class="formula-number">${escapeXml(block.number)}</span>` : "";
      return `<div class="formula"${attrs}>\n${mathml(block.tex, block.display)}${number}\n</div>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${item.map((b) => renderBlock(b, ctx)).join("\n")}</li>`)
        .join("\n");
      return `<${tag}${attrs}>\n${items}\n</${tag}>`;
    }
  }
}

function renderFootnotes(book: Book, ctx: RenderCtx): string {
  const entries = Object.entries(book.footnotes);
  if (entries.length === 0) return "";
  const asides = entries
    .map(
      ([id, note]) =>
        `<aside id="${escapeXml(id)}" epub:type="footnote">\n<sup>${escapeXml(note.label)}</sup>\n${note.blocks
          .map((b) => renderBlock(b, ctx))
          .join("\n")}\n</aside>`
    )
    .join("\n");
  return `\n<section class="footnotes" role="doc-endnotes">\n${asides}\n</section>`;
}

// Reading-oriented defaults: book paragraphs (no gaps, first-line indents),
// centered headings and separators, tight verse. Deliberately minimal — the
// reader's own settings keep control of face, size, and justification.
const STYLESHEET = `body { line-height: 1.5; }
h1, h2, h3, h4, h5, h6 { text-align: center; margin: 1.5em 0 0.8em; line-height: 1.25; }
p { margin: 0; text-indent: 1.2em; }
h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p, figure + p, hr + p { text-indent: 0; }
p.role-separator { text-align: center; text-indent: 0; margin: 1em 0; }
p.role-verse { text-indent: 0; margin: 0 0 0 2em; }
blockquote { margin: 1em 2em; }
blockquote p { text-indent: 0; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; }
figcaption { font-size: 0.9em; font-style: italic; margin-top: 0.4em; }
table { margin: 1em auto; border-collapse: collapse; }
td, th { padding: 0.2em 0.6em; border: 1px solid currentColor; }
div.formula { margin: 1em 0; text-align: center; }
section.footnotes { margin-top: 2em; border-top: 1px solid currentColor; padding-top: 1em; }
section.footnotes p { text-indent: 0; }
`;

const xhtmlShell = (title: string, language: string, body: string, cssHref: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="${cssHref}"/>
</head>
<body>
${body}
</body>
</html>
`;

/** Dialect → the plain text a menu label needs (markup stripped). */
function plainText(dialect: string): string {
  const walk = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => {
        switch (n.kind) {
          case "text":
            return n.text;
          case "math":
            return n.tex;
          case "noteref":
            return "";
          default:
            return walk(n.children);
        }
      })
      .join("");
  try {
    return walk(parseInline(dialect));
  } catch {
    return dialect;
  }
}

function navDoc(book: Book, pages: number[]): string {
  // nested TOC from headings with ids; deep levels (4+) are structure, not
  // navigation, and stay out of the menu
  const headings = book.content.filter(
    (b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && !!b.id && b.level <= 3
  );
  const lines: string[] = [];
  let depth = 0;
  const indent = (n: number) => "  ".repeat(n + 2);
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const level = Math.max(1, h.level);
    while (depth < level) {
      lines.push(`${indent(depth)}<ol>`);
      depth++;
    }
    while (depth > level) {
      depth--;
      lines.push(`${indent(depth + 1)}</li>`);
      lines.push(`${indent(depth)}</ol>`);
    }
    const next = headings[i + 1];
    const entry = `${indent(depth)}<li><a href="text/body.xhtml#${escapeXml(h.id!)}">${escapeXml(plainText(h.text))}</a>`;
    if (next && next.level > level) lines.push(entry);
    else lines.push(entry + "</li>");
  }
  while (depth > 0) {
    depth--;
    if (depth > 0) lines.push(`${indent(depth + 1)}</li>`);
    lines.push(`${indent(depth)}</ol>`);
  }
  let body = `  <nav epub:type="toc">
${lines.join("\n")}
  </nav>`;
  if (pages.length > 0) {
    const pageEntries = pages
      .map((p) => `      <li><a href="text/body.xhtml#page-${p}">${p}</a></li>`)
      .join("\n");
    body += `
  <nav epub:type="page-list" hidden="hidden">
    <ol>
${pageEntries}
    </ol>
  </nav>`;
  }
  return xhtmlShell(book.title, book.language, body, "style.css");
}

function packageOpf(book: Book, assetPaths: string[]): string {
  const items = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="css" href="style.css" media-type="text/css"/>`,
    `    <item id="body" href="text/body.xhtml" media-type="application/xhtml+xml"/>`,
    ...assetPaths.map((path, i) => {
      const props = path === book.cover ? ` properties="cover-image"` : "";
      return `    <item id="asset-${i}" href="${escapeXml(path)}" media-type="${mediaType(path)}"${props}/>`;
    }),
  ].join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:language>${escapeXml(book.language)}</dc:language>
${book.author ? `    <dc:creator>${escapeXml(book.author)}</dc:creator>\n` : ""}    <meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
${items}
  </manifest>
  <spine>
    <itemref idref="body"/>
  </spine>
</package>
`;
}

export async function writeEpub(book: Book, assets: Map<string, Uint8Array>): Promise<Uint8Array> {
  const assetPaths = referencedAssets(book);
  for (const path of assetPaths)
    if (!assets.has(path)) throw new Error(`referenced asset missing: ${path}`);

  const ctx: RenderCtx = { footnotes: book.footnotes };
  // §4.4 — pagebreak spans: one per page, at its first occurrence. A page
  // starting at a block boundary gets a span before the block; a page
  // starting mid-text gets its span injected at the break offset. Later
  // pages of non-text (or annotated) blocks fall back to a span after it.
  const seenPages: number[] = [];
  const pieces: string[] = [];
  for (const block of book.content) {
    const first = block.page ?? block.pages?.[0]?.page;
    if (first !== undefined && !seenPages.includes(first)) {
      seenPages.push(first);
      pieces.push(pageSpan(first));
    }
    const later = (block.pages ?? [])
      .slice(1)
      .filter((s) => !seenPages.includes(s.page)) as { page: number; at: number }[];
    later.forEach((s) => seenPages.push(s.page));
    const injectable = "text" in block && !block.annotations && later.length > 0;
    pieces.push(
      renderBlock(block, injectable ? { ...ctx, breaks: later.map((s) => ({ at: s.at, page: s.page })) } : ctx)
    );
    if (!injectable) for (const s of later) pieces.push(pageSpan(s.page));
  }
  const body = pieces.join("\n") + renderFootnotes(book, ctx);

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
  );
  zip.file("OEBPS/package.opf", packageOpf(book, assetPaths));
  zip.file("OEBPS/nav.xhtml", navDoc(book, seenPages));
  zip.file("OEBPS/text/body.xhtml", xhtmlShell(book.title, book.language, body, "../style.css"));
  zip.file("OEBPS/style.css", STYLESHEET);
  for (const path of assetPaths) zip.file(`OEBPS/${path}`, assets.get(path)!);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });
}
