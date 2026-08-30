import type { Block } from "./api";

/** What a recognized block will be in the EPUB, and the text it carries. */
export function describeBlock(block: Block): { kind: string; text: string } {
  switch (block.type) {
    case "heading":
      return { kind: `h${block.level}`, text: block.text };
    case "text":
      return { kind: block.role ?? "paragraph", text: block.text };
    case "quote":
      return { kind: "quote", text: block.text };
    case "image":
      return { kind: "figure", text: block.caption ?? "(image, no caption)" };
    case "table":
      return block.rows
        ? { kind: "table", text: `${block.rows.length} × ${block.rows[0]?.length ?? 0} cells` }
        : { kind: "table", text: "kept as a picture — no grid parsed" };
    case "formula":
      return { kind: "formula", text: block.tex ?? "(image)" };
    case "list":
      return { kind: "list", text: `${block.items.length} items` };
  }
}
