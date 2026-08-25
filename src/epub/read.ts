// EPUB → contract (DESIGN.md tool `epub-read`). Handles both our own output
// and foreign EPUBs (Gutenberg-style markup): content nested in containers,
// cross-document links, non-kebab ids, wrapped source text. Two passes: first
// collect every element id across the spine and build a sanitized-id map,
// then parse blocks resolving links through that map. Dangling links are
// demoted to plain text with a warning — the contract never holds one (§4.2).
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { walkBlocks, type Block, type Book, type Footnote } from "../contract.js";
import { parseInline, renderInline, type InlineNode } from "../inline.js";

type Attrs = Record<string, string>;
type XNode = { ":@"?: Attrs; "#text"?: string } & { [tag: string]: unknown };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

const tagOf = (n: XNode): string | undefined =>
  Object.keys(n).find((k) => k !== ":@" && k !== "#text");
const kids = (n: XNode): XNode[] => (n[tagOf(n)!] ?? []) as XNode[];
const attr = (n: XNode, name: string): string | undefined => n[":@"]?.["@" + name];
const classes = (n: XNode): string[] => (attr(n, "class") ?? "").split(/\s+/).filter(Boolean);
const isWs = (n: XNode) => "#text" in n && /^\s*$/.test(n["#text"] ?? "");

function findTag(nodes: XNode[], tag: string): XNode | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    if (tagOf(n)) {
      const hit = findTag(kids(n), tag);
      if (hit) return hit;
    }
  }
  return undefined;
}
const textContent = (n: XNode): string =>
  "#text" in n ? n["#text"] ?? "" : kids(n).map(textContent).join("");

const escapeDialect = (s: string) => s.replace(/[\\*$[\]^]/g, (m) => "\\" + m);
const cpLen = (s: string) => [...s].length;

/** Elements whose children are read as blocks in place of the element. */
const CONTAINERS = new Set(["section", "article", "header", "footer", "main", "hgroup"]);

const sanitizeId = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

type ReadCtx = {
  /** raw DOM id → unique kebab-case id */
  ids: Map<string, string>;
  /** ids that collapsed onto another block (inline anchors, container ids) → surviving block id */
  aliases: Map<string, string>;
  footnotes: Record<string, Footnote>;
  warnings: string[];
};

/** Pass 1: every element id in every spine document, sanitized uniquely. */
function collectIds(bodies: XNode[][]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const visit = (nodes: XNode[]) => {
    for (const n of nodes) {
      if (!tagOf(n)) continue;
      const raw = attr(n, "id");
      if (raw !== undefined && !map.has(raw)) {
        let s = sanitizeId(raw);
        for (let i = 2; used.has(s); i++) s = `${sanitizeId(raw)}-${i}`;
        map.set(raw, s);
        used.add(s);
      }
      visit(kids(n));
    }
  };
  for (const body of bodies) visit(body);
  return map;
}

type InlineResult = {
  text: string;
  breaks: { page: number; at: number }[];
  annotations: NonNullable<Block["annotations"]>;
  /** raw ids of inline <a id> anchors — candidates for the enclosing block's id */
  anchors: string[];
};

/**
 * XHTML phrasing content → dialect source string plus extracted provenance.
 * Whitespace runs in source text collapse to single spaces (books reflow;
 * source files wrap lines); <br/> becomes a space — the contract has no line
 * break, a loss the losses table predicted for poetry.
 */
function inlineOf(nodes: XNode[], ctx: ReadCtx): InlineResult {
  let text = "";
  const breaks: InlineResult["breaks"] = [];
  const annotations: InlineResult["annotations"] = [];
  const anchors: string[] = [];
  const nested = (children: XNode[]): string => {
    const inner = inlineOf(children, ctx);
    anchors.push(...inner.anchors);
    return inner.text;
  };
  const appendProse = (raw: string) => {
    let chunk = raw.replace(/\s+/g, " ");
    if (chunk.startsWith(" ") && (text === "" || text.endsWith(" "))) chunk = chunk.slice(1);
    text += escapeDialect(chunk);
  };
  for (const n of nodes) {
    if ("#text" in n) {
      appendProse(n["#text"] ?? "");
      continue;
    }
    const tag = tagOf(n);
    switch (tag) {
      case "em":
      case "i":
        text += `*${nested(kids(n))}*`;
        break;
      case "strong":
      case "b":
        text += `**${nested(kids(n))}**`;
        break;
      case "br":
        appendProse(" ");
        break;
      case "math": {
        const ann = findTag(kids(n), "annotation");
        if (!ann) throw new Error("math element without an x-tex annotation");
        text += `$${textContent(ann)}$`;
        break;
      }
      case "a": {
        const href = attr(n, "href");
        const inner = nested(kids(n));
        const anchorId = attr(n, "id");
        if (anchorId !== undefined) anchors.push(anchorId);
        if (href === undefined) {
          // href-less <a> is an anchor mark, not a link
          text += inner;
          break;
        }
        if (attr(n, "epub:type") === "noteref") {
          const raw = href.replace(/^[^#]*#/, "");
          text += `[^${ctx.ids.get(raw) ?? sanitizeId(raw)}]`;
          break;
        }
        if (/^https?:\/\/\S+$/.test(href)) {
          text += `[${inner}](${href})`;
          break;
        }
        const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : undefined;
        const target = fragment !== undefined ? ctx.ids.get(fragment) : undefined;
        if (target !== undefined) {
          text += `[${inner}](#${target})`;
        } else {
          // dangling or unresolvable → the link demotes to its text (§4.2)
          ctx.warnings.push(`dropped link to "${href}" (target not found)`);
          text += inner;
        }
        break;
      }
      case "span": {
        if (attr(n, "epub:type") === "pagebreak") {
          breaks.push({ page: Number(attr(n, "aria-label")), at: cpLen(text) });
          break;
        }
        const innerText = nested(kids(n));
        const language = attr(n, "xml:lang") ?? attr(n, "lang");
        const smallCaps = classes(n).includes("small-caps");
        if (language !== undefined || smallCaps) {
          annotations.push({
            start: cpLen(text),
            end: cpLen(text) + cpLen(innerText),
            matches: innerText,
            ...(language !== undefined && { language }),
            ...(smallCaps && { style: "small-caps" as const }),
          });
        }
        text += innerText;
        break;
      }
      case "img":
        // an image amid running text has no contract representation yet
        ctx.warnings.push(`dropped inline image "${attr(n, "src") ?? "?"}"`);
        break;
      default:
        text += nested(kids(n));
    }
  }
  return { text, breaks, annotations, anchors };
}

/** Trim boundary whitespace, shifting recorded offsets to stay in sync. */
function finalizeInline(res: InlineResult): InlineResult {
  const lead = res.text.length - res.text.replace(/^ +/, "").length;
  const text = res.text.replace(/^ +/, "").replace(/ +$/, "");
  const len = cpLen(text);
  const clamp = (n: number) => Math.min(Math.max(n - lead, 0), len);
  return {
    text,
    breaks: res.breaks.map((b) => ({ ...b, at: clamp(b.at) })),
    annotations: res.annotations.map((a) => ({ ...a, start: clamp(a.start), end: clamp(a.end) })),
    anchors: res.anchors,
  };
}

type Provenance = { page?: number; pages?: { page: number; at?: number }[] };

/** Provenance state threaded through the body walk. */
class PageTracker {
  current: number | undefined;

  /** Apply a block's inline result; returns the provenance fields. */
  stamp(inline: InlineResult | null): Provenance {
    const startPage = this.current;
    if (inline && inline.breaks.length > 0) {
      this.current = inline.breaks.at(-1)!.page;
      if (startPage !== undefined)
        return { pages: [{ page: startPage }, ...inline.breaks.map((b) => ({ page: b.page, at: b.at }))] };
      return { page: this.current };
    }
    return startPage !== undefined ? { page: startPage } : {};
  }
}

const normalizeSrc = (src: string) => src.replace(/^(\.\.\/|\.\/)+/, "");

function imageBlock(img: XNode, base: object, stamp: Provenance): Block {
  const alt = attr(img, "alt");
  return {
    type: "image",
    file: normalizeSrc(attr(img, "src") ?? ""),
    ...(alt !== undefined && alt !== "" && { alt }),
    ...base,
    ...stamp,
  };
}

function parseBlock(node: XNode, tracker: PageTracker, ctx: ReadCtx): Block | null {
  const tag = tagOf(node);
  if (!tag) return null;
  const rawId = attr(node, "id");
  const id = rawId !== undefined ? ctx.ids.get(rawId) ?? sanitizeId(rawId) : undefined;
  const language = attr(node, "xml:lang") ?? attr(node, "lang");
  // only our own prefixed classes map back to roles — foreign classes
  // ("pginternal", "chapter") are presentation, not semantics. `hidden` is
  // presentation too: the writer derives it from the role (I3), so reading it
  // back would duplicate what the class already carries.
  const role = classes(node)
    .find((c) => c.startsWith("role-"))
    ?.slice(5);
  const base = {
    ...(id !== undefined && { id }),
    ...(role !== undefined && { role }),
    ...(language !== undefined && { language }),
  };
  // Block id precedence: the element's own id, else the first inline anchor's
  // id (Gutenberg puts chapter ids on <a id> inside the heading). Every other
  // candidate becomes an alias so links to it still resolve.
  const withText = (inline: InlineResult) => {
    const anchorIds = inline.anchors.map((raw) => ctx.ids.get(raw) ?? sanitizeId(raw));
    const chosen = id ?? anchorIds[0];
    if (chosen !== undefined)
      for (const a of anchorIds) if (a !== chosen) ctx.aliases.set(a, chosen);
    return {
      ...base,
      ...(chosen !== undefined && { id: chosen }),
      ...(inline.annotations.length > 0 && { annotations: inline.annotations }),
      ...tracker.stamp(inline),
    };
  };

  const headingMatch = /^h([1-6])$/.exec(tag);
  if (headingMatch) {
    const inline = finalizeInline(inlineOf(kids(node), ctx));
    return { type: "heading", level: Number(headingMatch[1]), text: inline.text, ...withText(inline) };
  }
  switch (tag) {
    case "p": {
      const inline = finalizeInline(inlineOf(kids(node), ctx));
      if (inline.text === "") {
        // a paragraph that is only an image wrapper becomes an image block
        const img = kids(node).find((k) => tagOf(k) === "img");
        if (img) {
          ctx.warnings.pop(); // undo the inline-image warning from inlineOf
          return imageBlock(img, base, tracker.stamp(null));
        }
        return null;
      }
      return { type: "text", text: inline.text, ...withText(inline) };
    }
    case "blockquote": {
      const p = kids(node).find((k) => tagOf(k) === "p");
      const cite = findTag(kids(node), "cite");
      const inline = finalizeInline(inlineOf(p ? kids(p) : [], ctx));
      return {
        type: "quote",
        text: inline.text,
        ...(cite && { attribution: textContent(cite) }),
        ...withText(inline),
      };
    }
    case "img":
      return imageBlock(node, base, tracker.stamp(null));
    case "figure": {
      const img = kids(node).find((k) => tagOf(k) === "img");
      const figcaption = kids(node).find((k) => tagOf(k) === "figcaption");
      if (!img) return null;
      const src = normalizeSrc(attr(img, "src") ?? "");
      const caption = figcaption ? textContent(figcaption) : undefined;
      const cls = classes(img);
      const stamp = tracker.stamp(null);
      if (cls.includes("table"))
        return {
          type: "table",
          rows: null,
          image: src,
          ...(caption !== undefined && { caption }),
          ...(attr(img, "data-scanned") === "true" && { scanned: true }),
          ...base,
          ...stamp,
        };
      if (cls.includes("formula"))
        return {
          type: "formula",
          display: true,
          tex: null,
          image: src,
          ...(attr(img, "data-note") !== undefined && { note: attr(img, "data-note")! }),
          ...base,
          ...stamp,
        };
      return {
        ...imageBlock(img, base, stamp),
        ...(caption !== undefined && { caption }),
      };
    }
    case "table": {
      const caption = kids(node).find((k) => tagOf(k) === "caption");
      const sections = kids(node).flatMap((k) =>
        ["thead", "tbody", "tfoot"].includes(tagOf(k) ?? "") ? kids(k) : [k]
      );
      const rows = sections
        .filter((k) => tagOf(k) === "tr")
        .map((tr) =>
          kids(tr)
            .filter((k) => tagOf(k) === "td" || tagOf(k) === "th")
            .map((cell) => finalizeInline(inlineOf(kids(cell), ctx)).text)
        );
      return {
        type: "table",
        rows,
        ...(caption && { caption: textContent(caption) }),
        ...base,
        ...tracker.stamp(null),
      };
    }
    case "div": {
      if (!classes(node).includes("formula")) return null; // containers handled by blocksOf
      const math = kids(node).find((k) => tagOf(k) === "math");
      const ann = math && findTag(kids(math), "annotation");
      const numberSpan = kids(node).find(
        (k) => tagOf(k) === "span" && classes(k).includes("formula-number")
      );
      return {
        type: "formula",
        display: math ? attr(math, "display") === "block" : true,
        tex: ann ? textContent(ann) : null,
        ...(numberSpan && { number: textContent(numberSpan) }),
        ...base,
        ...tracker.stamp(null),
      };
    }
    case "ol":
    case "ul": {
      // the writer emits no provenance inside list items, so none is
      // reconstructed there — an inert tracker keeps nested blocks unstamped
      const itemTracker = new PageTracker();
      const items = kids(node)
        .filter((k) => tagOf(k) === "li")
        .map((li) => {
          const blocks = blocksOf(kids(li), itemTracker, ctx);
          if (blocks.length > 0) return blocks;
          // an item holding bare inline content (a TOC entry) is one text block
          const inline = finalizeInline(inlineOf(kids(li), ctx));
          return inline.text === "" ? [] : [{ type: "text", text: inline.text } satisfies Block];
        });
      return { type: "list", ordered: tag === "ol", items, ...base, ...tracker.stamp(null) };
    }
  }
  return null;
}

/** Flow content → blocks: recurse into containers, parse what we know. */
function blocksOf(nodes: XNode[], tracker: PageTracker, ctx: ReadCtx): Block[] {
  const blocks: Block[] = [];
  for (const node of nodes.filter((k) => !isWs(k))) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (tag === "span" && attr(node, "epub:type") === "pagebreak") {
      tracker.current = Number(attr(node, "aria-label"));
      continue;
    }
    if (
      tag === "section" &&
      (classes(node).includes("footnotes") || attr(node, "role") === "doc-endnotes")
    ) {
      parseFootnotes(node, ctx);
      continue;
    }
    if (CONTAINERS.has(tag) || (tag === "div" && !classes(node).includes("formula"))) {
      const inner = blocksOf(kids(node), tracker, ctx);
      // a container's id (Gutenberg wraps chapters in divs) hoists onto its
      // first block, or aliases to that block's id if it already has one
      const rawId = attr(node, "id");
      if (rawId !== undefined && inner[0]) {
        const containerId = ctx.ids.get(rawId) ?? sanitizeId(rawId);
        if (inner[0].id === undefined) inner[0] = { ...inner[0], id: containerId };
        else if (inner[0].id !== containerId) ctx.aliases.set(containerId, inner[0].id);
      }
      blocks.push(...inner);
      continue;
    }
    const block = parseBlock(node, tracker, ctx);
    if (block) blocks.push(block);
  }
  return blocks;
}

function parseFootnotes(section: XNode, ctx: ReadCtx): void {
  // footnote asides get no page provenance (they sit at the document end)
  const tracker = new PageTracker();
  for (const aside of kids(section).filter((k) => tagOf(k) === "aside")) {
    const rawId = attr(aside, "id");
    if (rawId === undefined) continue;
    const id = ctx.ids.get(rawId) ?? sanitizeId(rawId);
    const children = kids(aside).filter((k) => !isWs(k));
    const sup = children.find((k) => tagOf(k) === "sup");
    const blocks = blocksOf(
      children.filter((k) => k !== sup),
      tracker,
      ctx
    );
    ctx.footnotes[id] = { label: sup ? textContent(sup) : "?", blocks };
  }
}

/**
 * Post-pass: demote any internal link whose target did not survive as a block
 * or footnote id (§4.2 — the contract never holds a dangling link). Ids can
 * be lost when their carrier was an inline anchor or an empty container.
 */
function demoteDanglingLinks(book: Book, warnings: string[], aliases: Map<string, string>): void {
  const valid = new Set<string>(Object.keys(book.footnotes));
  for (const { block } of walkBlocks(book)) if (block.id) valid.add(block.id);
  const rewrite = (text: string): string => {
    let changed = false;
    const walk = (nodes: InlineNode[]): InlineNode[] =>
      nodes.flatMap((n) => {
        if (n.kind === "link" && n.target.kind === "internal" && !valid.has(n.target.id)) {
          const alias = aliases.get(n.target.id);
          if (alias !== undefined && valid.has(alias)) {
            changed = true;
            return [{ ...n, target: { kind: "internal" as const, id: alias }, children: walk(n.children) }];
          }
          changed = true;
          warnings.push(`dropped link to "#${n.target.id}" (no such block)`);
          return walk(n.children);
        }
        if ("children" in n) return [{ ...n, children: walk(n.children) }];
        return [n];
      });
    try {
      const out = renderInline(walk(parseInline(text)));
      return changed ? out : text;
    } catch {
      return text;
    }
  };
  for (const { block } of walkBlocks(book)) {
    if ("text" in block) block.text = rewrite(block.text);
    if ("caption" in block && block.caption !== undefined) block.caption = rewrite(block.caption);
  }
}

/** dc:* values may be plain strings or objects when the element has attrs. */
const dcText = (v: unknown): string | undefined => {
  const single = Array.isArray(v) ? v[0] : v;
  if (single === undefined || single === null) return undefined;
  if (typeof single === "object") return String((single as Record<string, unknown>)["#text"] ?? "");
  return String(single);
};

export type ReadResult = { book: Book; assets: Map<string, Uint8Array>; warnings: string[] };

export async function readEpub(bytes: Uint8Array): Promise<ReadResult> {
  const zip = await JSZip.loadAsync(bytes);
  const readFile = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`missing zip entry: ${path}`);
    return file.async("string");
  };

  const plain = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
  const container = plain.parse(await readFile("META-INF/container.xml"));
  const rootfile = [container.container.rootfiles.rootfile].flat()[0];
  const opfPath: string = rootfile["@full-path"];
  const opfDir = opfPath.split("/").slice(0, -1).join("/");
  const resolve = (href: string) => (opfDir ? `${opfDir}/${href}` : href);

  const opf = plain.parse(await readFile(opfPath));
  const metadata = opf.package.metadata;
  const manifestItems: Record<string, string>[] = [opf.package.manifest.item].flat();
  const props = (item: Record<string, string>) => (item["@properties"] ?? "").split(/\s+/);

  let cover: string | undefined;
  const docs: string[] = [];
  for (const item of manifestItems) {
    if (item["@media-type"] === "application/xhtml+xml" && !props(item).includes("nav"))
      docs.push(item["@href"]!);
    if (props(item).includes("cover-image")) cover = item["@href"]!;
  }

  // pass 1: parse all spine documents, collect ids
  const bodies: XNode[][] = [];
  for (const doc of docs) {
    const tree = parser.parse(await readFile(resolve(doc))) as XNode[];
    const html = tree.find((n) => tagOf(n) === "html");
    const body = html && kids(html).find((n) => tagOf(n) === "body");
    if (body) bodies.push(kids(body));
  }
  const ctx: ReadCtx = { ids: collectIds(bodies), aliases: new Map(), footnotes: {}, warnings: [] };

  // pass 2: blocks
  const tracker = new PageTracker();
  const content: Block[] = bodies.flatMap((body) => blocksOf(body, tracker, ctx));

  const book: Book = {
    title: dcText(metadata["dc:title"]) ?? "",
    language: dcText(metadata["dc:language"]) ?? "",
    ...(dcText(metadata["dc:creator"]) !== undefined && { author: dcText(metadata["dc:creator"])! }),
    ...(cover !== undefined && { cover }),
    content,
    footnotes: ctx.footnotes,
  };
  demoteDanglingLinks(book, ctx.warnings, ctx.aliases);

  // only assets the book actually references are carried (plus the cover)
  const assets = new Map<string, Uint8Array>();
  const wanted = new Set<string>();
  if (book.cover) wanted.add(book.cover);
  for (const { block } of walkBlocks(book)) {
    if ("file" in block) wanted.add(block.file);
    if ("image" in block && block.image !== undefined) wanted.add(block.image);
  }
  for (const name of wanted) {
    const file = zip.file(resolve(name));
    if (file) assets.set(name, await file.async("uint8array"));
    else ctx.warnings.push(`referenced asset not in EPUB: ${name}`);
  }

  return { book, assets, warnings: ctx.warnings };
}
