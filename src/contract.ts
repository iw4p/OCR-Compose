// The document contract (DESIGN.md §4). One flat ordered `content` list for
// the whole book (I1); role, never position (I2); every block type exists from
// day one with nullable fidelity fields (§3.3). Strict objects throughout so
// a typo in a hand-edited book.json is a validation error, not silence.
import { z } from "zod";
import { ID_PATTERN, parseInline, InlineParseError, type InlineNode } from "./inline.js";

const Id = z.string().regex(ID_PATTERN, "ids are lowercase kebab-case");

// §4.4 — page provenance. Single page: `page: 41`. Merged across pages:
// `pages: [{page: 41}, {page: 42, at: 47}]` where `at` is the code-point
// offset where that page begins (recorded by `unwrap`, unrecoverable later).
const PageSpan = z.strictObject({
  page: z.int().positive(),
  at: z.int().positive().optional(),
});
const PageList = z
  .array(PageSpan)
  .min(2, "use `page` for single-page blocks")
  .superRefine((spans, ctx) => {
    spans.forEach((span, i) => {
      if (i === 0 && span.at !== undefined)
        ctx.addIssue({ code: "custom", path: [0, "at"], message: "first page entry must not carry `at`" });
      if (i > 0 && span.at === undefined)
        ctx.addIssue({ code: "custom", path: [i, "at"], message: "page entries after the first require `at` (break offset)" });
    });
  });

// §4.5 — spans the inline dialect cannot express. `matches` is required and
// checked against text.slice(start, end) by validateBook, so a hand-edit that
// shifts offsets is an error, not silent corruption.
const Annotation = z.strictObject({
  start: z.int().nonnegative(),
  end: z.int().positive(),
  matches: z.string().min(1),
  language: z.string().optional(),
  style: z.enum(["small-caps"]).optional(),
});

// Fields shared by every block. `page`/`pages` are mutually exclusive —
// enforced by BookSchema's walk (a per-member refine cannot see into
// recursive list items).
const common = {
  id: Id.optional(),
  role: z.string().optional(),
  page: z.int().positive().optional(),
  pages: PageList.optional(),
  language: z.string().optional(),
  annotations: z.array(Annotation).optional(),
};

const HeadingBlock = z.strictObject({
  type: z.literal("heading"),
  level: z.int().min(1).max(6),
  text: z.string(),
  ...common,
});
const TextBlock = z.strictObject({ type: z.literal("text"), text: z.string(), ...common });
const QuoteBlock = z.strictObject({
  type: z.literal("quote"),
  text: z.string(),
  attribution: z.string().optional(),
  ...common,
});
const ImageBlock = z.strictObject({
  type: z.literal("image"),
  file: z.string(),
  caption: z.string().optional(),
  alt: z.string().optional(),
  ...common,
});
// §3.3 fidelity levels: `rows` present → <table>, else → <figure><img>.
const TableBlock = z.strictObject({
  type: z.literal("table"),
  rows: z.array(z.array(z.string())).nullable(),
  image: z.string().optional(),
  caption: z.string().optional(),
  scanned: z.boolean().optional(),
  ...common,
});
// `tex` present → MathML, else image.
const FormulaBlock = z.strictObject({
  type: z.literal("formula"),
  display: z.boolean(),
  tex: z.string().nullable(),
  image: z.string().optional(),
  number: z.string().optional(),
  note: z.string().optional(),
  ...common,
});
const ListBlock = z.strictObject({
  type: z.literal("list"),
  ordered: z.boolean(),
  get items() {
    return z.array(z.array(BlockSchema));
  },
  ...common,
});

// The explicit Block type exists to break the recursive-inference cycle
// (list items contain blocks). It must mirror the schemas above; the
// `: z.ZodType<Block>` annotation on BlockSchema keeps them honest.
type BlockCommon = {
  id?: string;
  role?: string;
  page?: number;
  pages?: { page: number; at?: number }[];
  language?: string;
  annotations?: { start: number; end: number; matches: string; language?: string; style?: "small-caps" }[];
};
export type Block = BlockCommon &
  (
    | { type: "heading"; level: number; text: string }
    | { type: "text"; text: string }
    | { type: "quote"; text: string; attribution?: string }
    | { type: "image"; file: string; caption?: string; alt?: string }
    | { type: "table"; rows: string[][] | null; image?: string; caption?: string; scanned?: boolean }
    | { type: "formula"; display: boolean; tex: string | null; image?: string; number?: string; note?: string }
    | { type: "list"; ordered: boolean; items: Block[][] }
  );

export const BlockSchema: z.ZodType<Block> = z.discriminatedUnion("type", [
  HeadingBlock,
  TextBlock,
  QuoteBlock,
  ImageBlock,
  TableBlock,
  FormulaBlock,
  ListBlock,
]);

const FootnoteSchema = z.strictObject({
  label: z.string().min(1),
  blocks: z.array(BlockSchema),
});
export type Footnote = z.infer<typeof FootnoteSchema>;

/** Every block in the book, depth-first: content, list items, footnotes. */
export function* walkBlocks(book: {
  content: Block[];
  footnotes: Record<string, Footnote>;
}): Generator<{ block: Block; path: (string | number)[] }> {
  function* walk(blocks: Block[], path: (string | number)[]): Generator<{ block: Block; path: (string | number)[] }> {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      yield { block, path: [...path, i] };
      if (block.type === "list")
        for (let j = 0; j < block.items.length; j++) yield* walk(block.items[j]!, [...path, i, "items", j]);
    }
  }
  yield* walk(book.content, ["content"]);
  for (const [id, note] of Object.entries(book.footnotes))
    yield* walk(note.blocks, ["footnotes", id, "blocks"]);
}

export const BookSchema = z
  .strictObject({
    title: z.string().min(1),
    author: z.string().optional(),
    language: z.string().min(2),
    cover: z.string().optional(),
    content: z.array(BlockSchema),
    footnotes: z.record(Id, FootnoteSchema).default({}),
  })
  .superRefine((book, ctx) => {
    for (const { block, path } of walkBlocks(book)) {
      if (block.page !== undefined && block.pages !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [...path, "pages"],
          message: "a block carries `page` or `pages`, never both",
        });
    }
  });
export type Book = z.infer<typeof BookSchema>;

export type ValidationIssue = { path: (string | number)[]; message: string };

// every field holding inline-dialect text, with its path inside the block —
// table cells carry the dialect too (real tables hold italics and links)
const textFields = (block: Block): [path: (string | number)[], value: string][] => {
  const fields: [(string | number)[], string][] = [];
  if ("text" in block) fields.push([["text"], block.text]);
  if ("caption" in block && block.caption !== undefined) fields.push([["caption"], block.caption]);
  if (block.type === "table" && block.rows !== null)
    block.rows.forEach((row, r) => row.forEach((cell, c) => fields.push([["rows", r, c], cell])));
  return fields;
};

function* walkInline(nodes: InlineNode[]): Generator<InlineNode> {
  for (const node of nodes) {
    yield node;
    if ("children" in node) yield* walkInline(node.children);
  }
}

/**
 * Full validation: schema shape plus the cross-checks the schema cannot see —
 * inline dialect syntax, link/noteref target existence, id uniqueness, and
 * annotation offset integrity (§4.2, §4.3, §4.5). Returns issues; never throws.
 */
export function validateBook(input: unknown): ValidationIssue[] {
  const parsed = BookSchema.safeParse(input);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({ path: [...i.path] as (string | number)[], message: i.message }));
  const book = parsed.data;
  const issues: ValidationIssue[] = [];

  // id collection + uniqueness (block ids and footnote ids share a namespace,
  // since links may target either)
  const ids = new Set<string>();
  const declare = (id: string, path: (string | number)[]) => {
    if (ids.has(id)) issues.push({ path, message: `duplicate id "${id}"` });
    ids.add(id);
  };
  for (const { block, path } of walkBlocks(book)) if (block.id) declare(block.id, [...path, "id"]);
  for (const id of Object.keys(book.footnotes)) declare(id, ["footnotes", id]);

  // per-block checks
  for (const { block, path } of walkBlocks(book)) {
    for (const [fieldPath, value] of textFields(block)) {
      let nodes: InlineNode[];
      try {
        nodes = parseInline(value);
      } catch (e) {
        if (!(e instanceof InlineParseError)) throw e;
        issues.push({ path: [...path, ...fieldPath], message: e.message });
        continue;
      }
      for (const node of walkInline(nodes)) {
        if (node.kind === "noteref" && !(node.id in book.footnotes))
          issues.push({ path: [...path, ...fieldPath], message: `footnote ref to nonexistent id "${node.id}"` });
        if (node.kind === "link" && node.target.kind === "internal" && !ids.has(node.target.id))
          issues.push({ path: [...path, ...fieldPath], message: `link to nonexistent id "${node.target.id}"` });
      }
    }
    for (const [i, ann] of (block.annotations ?? []).entries()) {
      const text = "text" in block ? block.text : "";
      const sliced = [...text].slice(ann.start, ann.end).join("");
      if (sliced !== ann.matches)
        issues.push({
          path: [...path, "annotations", i],
          message: `annotation offsets [${ann.start}, ${ann.end}) select ${JSON.stringify(sliced)}, which does not equal matches ${JSON.stringify(ann.matches)}`,
        });
    }
  }
  return issues;
}
