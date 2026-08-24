// The inline dialect (DESIGN.md §4.3). Closed set of constructs; everything
// else is literal text. Specials \ * $ [ ] ^ must be backslash-escaped in
// literals; an unescaped special that forms no construct is a parse error,
// never silently literal. Inside $math$ the body is raw TeX — only an
// unescaped $ terminates it.

export type LinkTarget = { kind: "internal"; id: string } | { kind: "external"; url: string };

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "math"; tex: string }
  | { kind: "noteref"; id: string }
  | { kind: "link"; children: InlineNode[]; target: LinkTarget };

/** Anchor ids: lowercase kebab-case (DESIGN.md §4.2). */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class InlineParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "InlineParseError";
  }
}

const SPECIALS = new Set(["\\", "*", "$", "[", "]", "^"]);

class Parser {
  private i = 0;
  private inLink = false;
  constructor(private readonly s: string) {}

  parse(): InlineNode[] {
    const nodes = this.parseNodes(null);
    if (this.i < this.s.length)
      throw new InlineParseError(`unescaped "${this.s[this.i]}"`, this.i);
    return nodes;
  }

  /** Parse until `closer` (left unconsumed) or end of input. */
  private parseNodes(closer: "*" | "**" | null): InlineNode[] {
    const nodes: InlineNode[] = [];
    let literal = "";
    const flush = () => {
      if (literal) nodes.push({ kind: "text", text: literal });
      literal = "";
    };
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (closer !== null && this.s.startsWith(closer, this.i)) {
        // Inside `*…*`, a run of exactly two asterisks opens a nested strong;
        // runs of 1 or 3+ close the em (a trailing `***` splits as `*` + `**`
        // for the enclosing strong).
        let run = 0;
        while (this.s[this.i + run] === "*") run++;
        if (!(closer === "*" && run === 2)) break;
      }
      if (c === "\\") {
        const next = this.s[this.i + 1];
        if (next === undefined || !SPECIALS.has(next))
          throw new InlineParseError(`invalid escape "\\${next ?? ""}"`, this.i);
        literal += next;
        this.i += 2;
      } else if (c === "$") {
        flush();
        nodes.push(this.parseMath());
      } else if (c === "*") {
        flush();
        nodes.push(this.parseDelimited(this.s.startsWith("**", this.i) ? "**" : "*"));
      } else if (c === "[") {
        if (this.inLink)
          throw new InlineParseError("nested link is not allowed", this.i);
        flush();
        nodes.push(this.parseBracket());
      } else if (c === "]" || c === "^") {
        break; // the caller decides whether this closes a construct or is an error
      } else {
        literal += c;
        this.i++;
      }
    }
    flush();
    return nodes;
  }

  private parseDelimited(delim: "*" | "**"): InlineNode {
    const start = this.i;
    this.i += delim.length;
    const children = this.parseNodes(delim);
    if (!this.s.startsWith(delim, this.i))
      throw new InlineParseError(`unclosed ${delim}emphasis${delim}`, start);
    this.i += delim.length;
    if (children.length === 0)
      throw new InlineParseError(`empty ${delim}emphasis${delim}`, start);
    return delim === "*" ? { kind: "em", children } : { kind: "strong", children };
  }

  /** `[^id]` footnote ref, or `[text](#id | https://…)` link. */
  private parseBracket(): InlineNode {
    const start = this.i;
    this.i++; // [
    if (this.s[this.i] === "^") {
      this.i++;
      const end = this.s.indexOf("]", this.i);
      if (end === -1) throw new InlineParseError("unclosed footnote ref", start);
      const id = this.s.slice(this.i, end);
      if (!ID_PATTERN.test(id))
        throw new InlineParseError(`footnote ref id "${id}" is not kebab-case`, this.i);
      this.i = end + 1;
      return { kind: "noteref", id };
    }
    this.inLink = true;
    const children = this.parseNodes(null);
    this.inLink = false;
    if (this.s[this.i] !== "]")
      throw new InlineParseError("unclosed link text (expected `](target)`)", start);
    this.i++;
    if (this.s[this.i] !== "(")
      throw new InlineParseError("link text must be followed by `(target)`", this.i);
    this.i++;
    const end = this.s.indexOf(")", this.i);
    if (end === -1) throw new InlineParseError("unclosed link target", this.i);
    const raw = this.s.slice(this.i, end);
    this.i = end + 1;
    if (children.length === 0) throw new InlineParseError("empty link text", start);
    let target: LinkTarget;
    if (raw.startsWith("#")) {
      const id = raw.slice(1);
      if (!ID_PATTERN.test(id))
        throw new InlineParseError(`link target id "${id}" is not kebab-case`, start);
      target = { kind: "internal", id };
    } else if (/^https?:\/\/\S+$/.test(raw)) {
      target = { kind: "external", url: raw };
    } else {
      throw new InlineParseError(
        `link target must be #id or an absolute http(s) URL, got "${raw}"`,
        start
      );
    }
    return { kind: "link", children, target };
  }

  private parseMath(): InlineNode {
    const start = this.i;
    this.i++; // opening $
    let tex = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "\\" && this.i + 1 < this.s.length) {
        tex += c + this.s[this.i + 1]!; // TeX escape: consume pair, incl. \$
        this.i += 2;
      } else if (c === "$") {
        this.i++;
        if (tex.length === 0) throw new InlineParseError("empty $math$", start);
        return { kind: "math", tex };
      } else {
        tex += c;
        this.i++;
      }
    }
    throw new InlineParseError("unclosed $math$", start);
  }
}

export function parseInline(s: string): InlineNode[] {
  return new Parser(s).parse();
}

const escapeLiteral = (text: string) => text.replace(/[\\*$[\]^]/g, (m) => "\\" + m);

export function renderInline(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeLiteral(node.text);
        break;
      case "em":
        out += `*${renderInline(node.children)}*`;
        break;
      case "strong":
        out += `**${renderInline(node.children)}**`;
        break;
      case "math":
        out += `$${node.tex}$`;
        break;
      case "noteref":
        out += `[^${node.id}]`;
        break;
      case "link":
        out += `[${renderInline(node.children)}](${
          node.target.kind === "internal" ? "#" + node.target.id : node.target.url
        })`;
        break;
    }
  }
  return out;
}
