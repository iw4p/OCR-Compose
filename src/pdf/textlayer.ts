// textlayer (DESIGN.md tool 2, §5.1): the per-page routing verdict the whole
// pipeline depends on. No ML — image coverage, font inspection, and a
// language-agnostic garble heuristic. Verdicts: `native` (real text layer),
// `scanned` (a rendered page must be OCRed, even if the PDF carries hidden
// OCR text), or `no-text` (a genuinely blank/non-content page).
import type { PdfPage } from "./extract.js";

export type TextLayerVerdict = "native" | "scanned" | "no-text";
export type PageReport = {
  page: number;
  verdict: TextLayerVerdict;
  chars: number;
  imageCoverage: number;
  garble: number;
};

const LATIN = /^[\p{Script=Latin}]+$/u;
const VOWELS = /[aeiouyàáâäåèéêëìíîïòóôöùúûüæøœ]/i;

/**
 * Fraction of word tokens that look like OCR damage: digit–letter mixes
 * ("w4s"), vowel-less latin words, or tokens dominated by symbols. Applied
 * only to signals that hold across languages; non-Latin scripts skip the
 * vowel test entirely.
 */
export function garbleScore(text: string): number {
  const tokens = text.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  if (tokens.length === 0) return 0;
  let weird = 0;
  for (const raw of tokens) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (token === "") continue;
    if (token.includes("�")) weird++;
    else if (/\p{L}\d|\d\p{L}/u.test(token)) weird++;
    else if (token.length > 3 && LATIN.test(token) && !VOWELS.test(token)) weird++;
    else if ((token.match(/[^\p{L}\p{N}'’\-]/gu)?.length ?? 0) / token.length > 0.3) weird++;
  }
  return weird / tokens.length;
}

export function judgePage(p: PdfPage): PageReport {
  const text = p.lines.flatMap((l) => l.runs.map((r) => r.text)).join(" ");
  const chars = text.replace(/\s+/g, "").length;
  const garble = garbleScore(text);
  let verdict: TextLayerVerdict;
  // A full-page image is always a scan. Its hidden text layer is deliberately
  // ignored: double-layer PDFs and image-only scans take the exact same OCR
  // route. Sparse/garbled extraction also falls back to OCR when the page has
  // enough visible content to render.
  if (p.imageCoverage > 0.8) verdict = "scanned";
  else if (chars < 20) verdict = p.imageCoverage > 0.3 ? "scanned" : "no-text";
  else verdict = garble > 0.4 ? "scanned" : "native";
  return { page: p.page, verdict, chars, imageCoverage: p.imageCoverage, garble };
}

export function textlayer(pages: PdfPage[]): {
  reports: PageReport[];
  counts: Record<TextLayerVerdict, number>;
} {
  const reports = pages.map(judgePage);
  const counts: Record<TextLayerVerdict, number> = {
    native: 0,
    scanned: 0,
    "no-text": 0,
  };
  for (const r of reports) counts[r.verdict]++;
  return { reports, counts };
}
