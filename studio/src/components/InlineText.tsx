import { parseInline, type InlineNode } from "../../../src/inline";

/**
 * The inline dialect, readable: emphasis as emphasis, math as TeX in a chip,
 * note refs as superscripts. Text that does not parse (it should always parse
 * — the book was validated) falls back to its raw source rather than to
 * nothing.
 */
export function InlineText({ text }: { text: string }) {
  let nodes: InlineNode[];
  try {
    nodes = parseInline(text);
  } catch {
    return <>{text}</>;
  }
  return <>{nodes.map((node, i) => render(node, i))}</>;
}

function render(node: InlineNode, key: number): React.ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "em":
      return <em key={key}>{node.children.map(render)}</em>;
    case "strong":
      return <strong key={key}>{node.children.map(render)}</strong>;
    case "math":
      return (
        <code key={key} className="tex" title="TeX — typeset in the EPUB">
          {node.tex}
        </code>
      );
    case "noteref":
      return <sup key={key}>[{node.id}]</sup>;
    case "link":
      return <span key={key} className="accent">{node.children.map(render)}</span>;
  }
}
