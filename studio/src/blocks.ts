import type { Block } from "../../src/contract";
import { ID_PATTERN } from "../../src/inline";

export const BLOCK_TYPES = ["heading", "text", "quote", "image", "table", "formula", "list"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: "Heading",
  text: "Paragraph",
  quote: "Quote",
  image: "Image",
  table: "Table",
  formula: "Formula",
  list: "List",
};

export function newBlock(type: BlockType): Block {
  switch (type) {
    case "heading":
      return { type: "heading", level: 2, text: "" };
    case "text":
      return { type: "text", text: "" };
    case "quote":
      return { type: "quote", text: "" };
    case "image":
      return { type: "image", file: "" };
    case "table":
      return { type: "table", rows: [["", ""]] };
    case "formula":
      return { type: "formula", display: true, tex: "" };
    case "list":
      return { type: "list", ordered: false, items: [[{ type: "text", text: "" }]] };
  }
}

export const blockLabel = (block: Block): string => BLOCK_LABELS[block.type];

// React needs a key stable across reorders/inserts/deletes/edits so component
// state (expanded/collapsed, drag state) stays attached to the right block,
// not the right array slot. Editing a block replaces it with a new object
// (`{...block, text: value}`), which would otherwise look "new" to React on
// every keystroke — carryKey() reassigns the outgoing object's key to its
// replacement so identity survives edits, not just reordering. Purely a
// render-time concern: never written to book.json.
let keySeq = 0;
const stableKeys = new WeakMap<object, number>();
export function keyOf(value: object): number {
  let key = stableKeys.get(value);
  if (key === undefined) {
    key = keySeq++;
    stableKeys.set(value, key);
  }
  return key;
}
export function carryKey<T extends object>(from: object, to: T): T {
  stableKeys.set(to, keyOf(from));
  return to;
}

/** Short, human-scannable preview text for a block in an outline / drag handle. */
export function blockPreview(block: Block): string {
  switch (block.type) {
    case "heading":
    case "text":
    case "quote":
      return block.text || "(empty)";
    case "image":
      return block.caption || block.file || "(no file)";
    case "table":
      return block.caption || (block.rows ? `${block.rows.length} rows` : "scanned table, no rows parsed");
    case "formula":
      return block.tex || block.number || "(no tex)";
    case "list":
      return `${block.items.length} item${block.items.length === 1 ? "" : "s"}`;
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** A stable, unique id derived from content — never `block-38` (DESIGN.md §4.2). */
export function suggestId(block: Block, taken: Set<string>): string {
  const base = slugify(
    block.type === "heading"
      ? block.text
      : block.type === "formula"
        ? block.number || "eq"
        : block.type === "image" || block.type === "table"
          ? block.caption || block.type
          : block.type,
  ) || block.type;
  const prefix = block.type === "heading" ? "sec" : block.type === "formula" ? "eq" : block.type === "image" ? "fig" : block.type;
  let candidate = `${prefix}-${base}`.replace(/^([a-z]+)-\1-/, "$1-");
  let n = 2;
  while (taken.has(candidate)) candidate = `${prefix}-${base}-${n++}`;
  return candidate;
}
