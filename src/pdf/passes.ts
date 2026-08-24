// The IR passes for the PDF front end (DESIGN.md tools 6–11, v1 scope):
// classify (page furniture), unwrap (lines → paragraphs, dehyphenation,
// cross-page merge with break offsets), detectHeadings (font-size outline).
// All pure functions over extract.ts data — independently testable.
import type { PdfLine, PdfPage } from "./extract.js";

const escapeDialect = (s: string) => s.replace(/[\\*$[\]^]/g, (m) => "\\" + m);
const cpLen = (s: string) => [...s].length;
const lineText = (l: PdfLine) => l.runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// classify — running headers/footers/page numbers by cross-page repetition
// ---------------------------------------------------------------------------

/** digits collapse so "9 Free eBooks…" and "10 Free eBooks…" match */
const furnitureKey = (l: PdfLine) => lineText(l).replace(/\d+/g, "#").toLowerCase();

export function classify(pages: PdfPage[]): { printedPages: Map<number, number> } {
  const printedPages = new Map<number, number>();
  if (pages.length >= 3) {
    const counts = new Map<string, number>();
    const zoneOf = (l: PdfLine, p: PdfPage): string | null =>
      l.y < p.height * 0.18 ? "top" : l.y + l.h > p.height * 0.78 ? "bottom" : null;
    for (const p of pages) {
      const seen = new Set<string>();
      for (const l of p.lines) {
        const zone = zoneOf(l, p);
        if (!zone) continue;
        const key = zone + "|" + furnitureKey(l);
        if (!seen.has(key)) {
          seen.add(key);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
    // second signal: an all-caps zone line carrying a page number is a
    // running head even when it repeats only within one chapter (scanned
    // books change their head text per chapter, defeating global counts)
    const capsRunningHead = (l: PdfLine) => {
      const text = lineText(l);
      return /\d/.test(text) && /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
    };
    // all-caps zone lines (chapter running heads) use the absolute threshold:
    // they change text per chapter, so they never reach the global count
    const allCaps = (l: PdfLine) => /\p{Lu}/u.test(lineText(l)) && !/\p{Ll}/u.test(lineText(l));
    for (const p of pages) {
      for (const l of p.lines) {
        const zone = zoneOf(l, p);
        if (!zone) continue;
        const count = counts.get(zone + "|" + furnitureKey(l)) ?? 0;
        if (count >= threshold || (allCaps(l) && count >= 3) || capsRunningHead(l)) {
          l.role = "furniture";
          const digits = /(?:^|\s)(\d{1,4})(?:\s|$)/.exec(lineText(l));
          if (digits && !printedPages.has(p.page)) printedPages.set(p.page, Number(digits[1]));
        }
      }
    }
  }
  return { printedPages };
}

// ---------------------------------------------------------------------------
// unwrap — body lines → paragraphs in dialect text
// ---------------------------------------------------------------------------

export type PageSpanList = { page: number; at?: number }[];
export type Paragraph = {
  kind: "paragraph" | "separator";
  text: string; // inline dialect
  size: number; // dominant font size
  page?: number;
  pages?: PageSpanList;
};

const mode = (values: number[]): number => {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
};

/** One line's runs → dialect text; italics wrap in *…*, bold in **…**. */
function lineDialect(l: PdfLine): string {
  type Seg = { text: string; italic: boolean; bold: boolean };
  const segs: Seg[] = [];
  for (const r of l.runs) {
    const text = r.text.replace(/\s+/g, " ");
    const prev = segs.at(-1);
    if (prev && prev.italic === r.italic && prev.bold === r.bold) prev.text += text;
    else segs.push({ text, italic: r.italic, bold: r.bold });
  }
  let out = "";
  for (const seg of segs) {
    if (!seg.italic && !seg.bold) {
      out += escapeDialect(seg.text);
      continue;
    }
    // boundary spaces stay outside the emphasis markers
    const lead = seg.text.match(/^ */)![0];
    const trail = seg.text.match(/ *$/)![0];
    const core = seg.text.slice(lead.length, seg.text.length - trail.length);
    if (core === "") {
      out += seg.text;
      continue;
    }
    const marker = seg.italic && seg.bold ? "***" : seg.bold ? "**" : "*";
    out += `${lead}${marker}${escapeDialect(core)}${marker}${trail}`;
  }
  return out.trim();
}

/** hyphenated compounds seen mid-line ("red-hot") — evidence to keep a hyphen */
function compoundEvidence(pages: PdfPage[]): Set<string> {
  const set = new Set<string>();
  for (const p of pages)
    for (const l of p.lines) {
      const text = lineText(l);
      for (const m of text.matchAll(/\p{L}+-\p{L}+/gu)) {
        if (m.index! + m[0].length < text.length) set.add(m[0].toLowerCase());
      }
    }
  return set;
}

export function unwrap(pages: PdfPage[], printedPages: Map<number, number>): Paragraph[] {
  const body = pages.flatMap((p) => p.lines.filter((l) => !l.role && lineText(l) !== ""));
  if (body.length === 0) return [];
  const compounds = compoundEvidence(pages);

  const bodyLeft = mode(body.map((l) => Math.round(l.x)));
  const modalW = mode(body.map((l) => Math.round(l.w / 10) * 10));
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) {
    const gap = body[i]!.y - body[i - 1]!.y;
    if (body[i]!.page === body[i - 1]!.page && gap > 0) gaps.push(Math.round(gap));
  }
  const modalGap = mode(gaps) || 12;

  const pageHeights = new Map(pages.map((p) => [p.page, p.height]));
  const isIndented = (l: PdfLine) => l.x >= bodyLeft + 4;
  const isCentered = (l: PdfLine) => l.x >= bodyLeft + 20 && l.w < modalW * 0.5;
  const isShort = (l: PdfLine) => l.w < modalW * 0.6;
  const domSize = (l: PdfLine) =>
    mode(l.runs.flatMap((r) => Array<number>(Math.max(1, r.text.length)).fill(Math.round(r.size))));
  const pageOf = (l: PdfLine) => printedPages.get(l.page) ?? l.page;

  const paras: Paragraph[] = [];
  let current: Paragraph | null = null;
  let prev: PdfLine | null = null;

  const flush = () => {
    if (current) paras.push(current);
    current = null;
  };

  for (const line of body) {
    let text = lineDialect(line);
    const separator = isCentered(line) && !/\p{L}/u.test(lineText(line));
    const newPara =
      current === null ||
      separator ||
      current.kind === "separator" ||
      isIndented(line) ||
      (prev !== null && prev.page === line.page && line.y - prev.y > modalGap * 1.7) ||
      (prev !== null && domSize(line) !== domSize(prev)) ||
      // a paragraph continues onto the next page only if the previous page
      // was interrupted near its bottom — a line stopping mid-page ends it
      (prev !== null &&
        prev.page !== line.page &&
        prev.y + prev.h < (pageHeights.get(prev.page) ?? 800) * 0.7) ||
      (prev !== null && isShort(prev));

    if (newPara) {
      flush();
      current = {
        kind: separator ? "separator" : "paragraph",
        text,
        size: domSize(line),
        page: pageOf(line),
      };
    } else {
      const cur = current!;
      // cross-page continuation: record where the new page begins (§4.4)
      const curLastPage = cur.pages ? cur.pages.at(-1)!.page : cur.page!;
      // emphasis continuing across the line break: `…sum­*` + `*mer…` is one
      // span — drop the close/open pair so hyphen joins stay inside it
      const closeMarker = /(?<!\\)(\*{1,3})$/.exec(cur.text)?.[1];
      if (closeMarker && text.startsWith(closeMarker) && !text.startsWith(closeMarker + "*")) {
        cur.text = cur.text.slice(0, -closeMarker.length);
        text = text.slice(closeMarker.length);
      }
      let joined = false;
      if (cur.text.endsWith("­")) {
        cur.text = cur.text.slice(0, -1) + text;
        joined = true;
      } else if (cur.text.endsWith("-")) {
        const tail = /(\p{L}+)-$/u.exec(cur.text)?.[1] ?? "";
        const head = /^\p{L}+/u.exec(text)?.[0] ?? "";
        const keep = compounds.has(`${tail}-${head}`.toLowerCase());
        cur.text = (keep ? cur.text : cur.text.slice(0, -1)) + text;
        joined = true;
      }
      const at = joined ? cpLen(cur.text) - cpLen(text) : cpLen(cur.text) + 1;
      if (!joined) cur.text += " " + text;
      if (pageOf(line) !== curLastPage) {
        if (!cur.pages) {
          cur.pages = [{ page: cur.page! }];
          delete cur.page;
        }
        cur.pages.push({ page: pageOf(line), at });
      }
    }
    prev = line;
  }
  flush();
  return paras;
}

// ---------------------------------------------------------------------------
// detectHeadings — outline from font sizes
// ---------------------------------------------------------------------------

export type DocBlock =
  | { kind: "heading"; level: number; text: string; page?: number; pages?: PageSpanList }
  | { kind: "paragraph"; text: string; page?: number; pages?: PageSpanList }
  | { kind: "separator"; text: string; page?: number };

export function bodyFontSize(pages: PdfPage[]): number {
  return mode(
    pages.flatMap((p) =>
      p.lines
        .filter((l) => !l.role)
        .flatMap((l) => l.runs.flatMap((r) => Array<number>(Math.max(1, r.text.length)).fill(Math.round(r.size))))
    )
  );
}

export function detectHeadings(paras: Paragraph[], bodySize: number): DocBlock[] {
  // drop caps: a 1–2 letter "paragraph" at display size is the opening
  // capital of the next paragraph — rejoin it (no space: "A" + "lice"),
  // otherwise it becomes the book's largest bogus heading
  const merged: Paragraph[] = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;
    const next = paras[i + 1];
    const letters = p.text.replace(/[^\p{L}]/gu, "");
    if (letters.length <= 2 && p.text.length <= 4 && p.size >= bodySize * 2 && next?.kind === "paragraph") {
      const joined = { ...next, text: p.text + next.text };
      if (!joined.pages && (p.page ?? next.page) !== undefined) joined.page = p.page ?? next.page;
      merged.push(joined);
      i++;
      continue;
    }
    merged.push(p);
  }
  const headingSizes = [
    ...new Set(merged.filter((p) => p.size >= bodySize * 1.25).map((p) => p.size)),
  ].sort((a, b) => b - a);
  const blocks = merged.map((p): DocBlock => {
    const provenance = { ...(p.page !== undefined && { page: p.page }), ...(p.pages && { pages: p.pages }) };
    if (p.kind === "separator") return { kind: "separator", text: p.text, ...provenance };
    const rank = headingSizes.indexOf(p.size);
    if (rank !== -1)
      return { kind: "heading", level: Math.min(rank + 1, 6), text: p.text, ...provenance };
    return { kind: "paragraph", text: p.text, ...provenance };
  });
  // a chapter number and its title (or a title wrapped over lines) are set as
  // consecutive heading lines on one page — one navigation target, one heading
  const out: DocBlock[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      b.kind === "heading" &&
      prev?.kind === "heading" &&
      prev.page !== undefined &&
      prev.page === b.page
    ) {
      prev.text += (prev.text.endsWith("-") || prev.text.endsWith("­") ? "" : " ") + b.text;
      prev.level = Math.min(prev.level, b.level);
      continue;
    }
    out.push(b);
  }
  return out;
}
