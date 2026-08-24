import { describe, expect, test } from "vitest";
import { parseInline, renderInline } from "./inline.js";

describe("literal text", () => {
  test("plain text parses to a single text node", () => {
    expect(parseInline("Die Wirkung S als Funktional.")).toEqual([
      { kind: "text", text: "Die Wirkung S als Funktional." },
    ]);
  });

  test("escaped specials parse to their literal characters", () => {
    expect(parseInline("costs \\$4 to \\$5, see \\[1\\], x\\^2, a\\*b, C:\\\\")).toEqual([
      { kind: "text", text: "costs $4 to $5, see [1], x^2, a*b, C:\\" },
    ]);
  });

  test("unescaped special that forms no construct is a parse error", () => {
    expect(() => parseInline("costs $4 per unit")).toThrow(/unclosed/i);
    expect(() => parseInline("a ] b")).toThrow(/unescaped/i);
    expect(() => parseInline("x^2")).toThrow(/unescaped/i);
  });

  test("underscore is NOT special (excluded from the dialect)", () => {
    expect(parseInline("snake_case_name")).toEqual([{ kind: "text", text: "snake_case_name" }]);
  });

  test("render escapes all six specials", () => {
    const s = renderInline([{ kind: "text", text: "$4 [a] x^2 a*b C:\\" }]);
    expect(s).toBe("\\$4 \\[a\\] x\\^2 a\\*b C:\\\\");
    expect(parseInline(s)).toEqual([{ kind: "text", text: "$4 [a] x^2 a*b C:\\" }]);
  });
});

describe("emphasis, strong, math", () => {
  test("*em* parses with surrounding text", () => {
    expect(parseInline("mit *innerer Symmetrie* zu")).toEqual([
      { kind: "text", text: "mit " },
      { kind: "em", children: [{ kind: "text", text: "innerer Symmetrie" }] },
      { kind: "text", text: " zu" },
    ]);
  });

  test("**strong** parses, and ***both*** nests em inside strong", () => {
    expect(parseInline("**Satz 2**")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "Satz 2" }] },
    ]);
    expect(parseInline("***wichtig***")).toEqual([
      { kind: "strong", children: [{ kind: "em", children: [{ kind: "text", text: "wichtig" }] }] },
    ]);
  });

  test("math body is raw TeX: backslashes and specials pass through", () => {
    expect(parseInline("Feld $\\phi(x,t)$ mit $x^2_i$")).toEqual([
      { kind: "text", text: "Feld " },
      { kind: "math", tex: "\\phi(x,t)" },
      { kind: "text", text: " mit " },
      { kind: "math", tex: "x^2_i" },
    ]);
  });

  test("TeX \\$ inside math does not close it", () => {
    expect(parseInline("$a\\$b$")).toEqual([{ kind: "math", tex: "a\\$b" }]);
  });

  test("empty or unclosed constructs are errors", () => {
    expect(() => parseInline("**")).toThrow(/unclosed|empty/i);
    expect(() => parseInline("*a")).toThrow(/unclosed/i);
    expect(() => parseInline("$$")).toThrow(/empty/i);
  });

  test("round-trips through render", () => {
    for (const s of ["mit *innerer Symmetrie* zu", "***wichtig***", "Feld $\\phi(x,t)$ mit $x^2_i$"]) {
      expect(renderInline(parseInline(s))).toBe(s);
    }
  });
});

describe("links and footnote refs", () => {
  test("[^id] parses to a noteref", () => {
    expect(parseInline("ersetzt wird.[^ch2-fn7]")).toEqual([
      { kind: "text", text: "ersetzt wird." },
      { kind: "noteref", id: "ch2-fn7" },
    ]);
  });

  test("internal link parses with id target", () => {
    expect(parseInline("wie in [Gl. 2.14](#eq-2-14) angelegt")).toEqual([
      { kind: "text", text: "wie in " },
      { kind: "link", children: [{ kind: "text", text: "Gl. 2.14" }], target: { kind: "internal", id: "eq-2-14" } },
      { kind: "text", text: " angelegt" },
    ]);
  });

  test("external link requires an absolute http(s) URL", () => {
    expect(parseInline("[MobileRead](https://mobileread.com/x?a=1)")).toEqual([
      { kind: "link", children: [{ kind: "text", text: "MobileRead" }], target: { kind: "external", url: "https://mobileread.com/x?a=1" } },
    ]);
    expect(() => parseInline("[rel](../other.html)")).toThrow(/absolute|target/i);
  });

  test("link text may contain em but not another link", () => {
    expect(parseInline("[*Dorian Gray*](#ch-1)")).toEqual([
      { kind: "link", children: [{ kind: "em", children: [{ kind: "text", text: "Dorian Gray" }] }], target: { kind: "internal", id: "ch-1" } },
    ]);
    expect(() => parseInline("[a [b](#x) c](#y)")).toThrow(/nested link|unescaped/i);
  });

  test("malformed bracket constructs are errors", () => {
    expect(() => parseInline("[^]")).toThrow(/footnote|id/i);
    expect(() => parseInline("[text]")).toThrow(/link|unclosed/i);
    expect(() => parseInline("[text](no space)")).toThrow(/target|absolute/i);
    expect(() => parseInline("[^Not-Kebab]")).toThrow(/id/i);
  });

  test("fuzz: render(parse(s)) === s and parse(render(nodes)) is stable", () => {
    const samples = [
      "ersetzt wird.[^ch2-fn7]",
      "wie in [Gl. 2.14](#eq-2-14) angelegt",
      "[*Dorian Gray*](#ch-1)",
      "**a *b* c** und $\\sum_{i}$ mit \\$5 \\[sic\\]",
      "Preis: \\$4 \\*Sternchen\\* x\\^2 \\\\ Ende",
    ];
    for (const s of samples) {
      const nodes = parseInline(s);
      expect(renderInline(nodes)).toBe(s);
      expect(parseInline(renderInline(nodes))).toEqual(nodes);
    }
  });
});
