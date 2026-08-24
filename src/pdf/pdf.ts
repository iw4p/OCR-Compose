// The PDF front end orchestrator: bytes → contract. Routes on the textlayer
// verdict (DESIGN.md §5.1): native pages use their text; scan-backed pages
// always use fresh OCR, including PDFs with a hidden OCR layer. Both flow
// through source-specific interpretation before converging as contract blocks.
// Geometry dies here — the Book carries only roles, text, and provenance.
import type { Block, Book } from "../contract.js";
import { extractPdf, renderPagePng, type PdfImage } from "./extract.js";
import { classify, detectHeadings, bodyFontSize, unwrap } from "./passes.js";
import { textlayer, type PageReport, type TextLayerVerdict } from "./textlayer.js";
import { ocrBlocksToBookBlocks, type OcrBlock, type OcrEngine } from "./ocr.js";

export type PdfOptions = {
  title?: string;
  author?: string;
  language?: string;
  /** Optional 1-based source PDF pages to convert, retaining original provenance. */
  pages?: number[];
  /** OCR engine for scan-backed pages */
  ocr?: OcrEngine;
  onProgress?: (done: number, total: number) => void;
};
export type PdfResult = {
  book: Book;
  assets: Map<string, Uint8Array>;
  warnings: string[];
  report: { counts: Record<TextLayerVerdict, number>; pages: PageReport[] };
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "section";

export async function pdfToBook(bytes: Uint8Array, opts: PdfOptions = {}): Promise<PdfResult> {
  const warnings: string[] = [];
  const extraction = extractPdf(bytes);
  if (opts.pages) {
    const available = new Set(extraction.pages.map((p) => p.page));
    const invalid = opts.pages.filter((page) => !available.has(page));
    if (invalid.length > 0)
      throw new Error(`PDF page selection is out of range: ${invalid.join(", ")}`);
    const selected = new Set(opts.pages);
    extraction.pages = extraction.pages.filter((page) => selected.has(page.page));
    if (extraction.pages.length === 0) throw new Error("PDF page selection is empty");
  }
  const { reports, counts } = textlayer(extraction.pages);
  const report = { counts, pages: reports };
  const reportByPage = new Map(reports.map((page) => [page.page, page]));

  // Every scan-backed page is freshly OCRed. In particular, never trust the
  // hidden text in a double-layer PDF; only the rendered, visible page enters
  // the OCR provider. OCR semantic blocks never pass through native line
  // unwrapping or font-size heading inference.
  const needsOcr = reports.filter((r) => r.verdict === "scanned");
  const ocrPages = new Set<number>();
  const ocrByPage = new Map<number, OcrBlock[]>();
  if (opts.ocr && needsOcr.length > 0) {
    const langs = opts.language ? [opts.language] : [];
    let done = 0;
    try {
      for (const r of needsOcr) {
        const raw = await opts.ocr.recognize(renderPagePng(bytes, r.page, 3), langs);
        const semantic = ocrBlocksToBookBlocks(raw, r.page);
        if (semantic.length > 0) {
          ocrByPage.set(r.page, raw);
          ocrPages.add(r.page);
        }
        opts.onProgress?.(++done, needsOcr.length);
      }
    } finally {
      await opts.ocr.close?.();
    }
    warnings.push(`${needsOcr.length} pages OCRed with ${opts.ocr.name}`);
  }

  const usable = counts.native + ocrPages.size;
  const total = extraction.pages.length;
  if (usable < total * 0.5)
    throw new Error(
      `no usable text: ${counts.scanned} scanned pages and ` +
        `${counts["no-text"]} blank pages (of ${total}). ` +
        `Scanned PDFs need PaddleOCR-VL 1.6 (\`bookforge pdf --ocr\`).`
    );

  // pages the passes may use; un-OCRed scan/blank pages in a mostly-native book are
  // skipped with a warning rather than poisoning the output
  const usablePages = extraction.pages.filter((p) => {
    const verdict = reportByPage.get(p.page)!.verdict;
    if (verdict === "native" || ocrPages.has(p.page)) return true;
    if (verdict !== "no-text") warnings.push(`page ${p.page} skipped (${verdict})`);
    return false;
  });

  const nativePages = usablePages.filter((page) => reportByPage.get(page.page)!.verdict === "native");
  const { printedPages } = classify(nativePages);

  // Native layout is interpreted in contiguous runs so pages separated by an
  // OCR page can never be accidentally joined into one paragraph.
  const nativeRuns: typeof nativePages[] = [];
  for (const page of nativePages) {
    const run = nativeRuns.at(-1);
    if (run && run.at(-1)!.page + 1 === page.page) run.push(page);
    else nativeRuns.push([page]);
  }

  const unordered: { block: Block; order: number }[] = [];
  let order = 0;
  for (const run of nativeRuns) {
    const docBlocks = detectHeadings(unwrap(run, printedPages), bodyFontSize(run));
    for (const block of docBlocks) {
      const provenance = {
        ...(block.page !== undefined && { page: block.page }),
        ...("pages" in block && block.pages !== undefined && { pages: block.pages }),
      };
      unordered.push({
        block:
          block.kind === "heading"
            ? { type: "heading", level: block.level, text: block.text, ...provenance }
            : { type: "text", text: block.text, ...(block.kind === "separator" && { role: "separator" }), ...provenance },
        order: order++,
      });
    }
  }
  for (const [page, raw] of ocrByPage)
    for (const block of ocrBlocksToBookBlocks(raw, page)) unordered.push({ block, order: order++ });

  unordered.sort((a, b) => (firstPageOf(a.block) ?? 0) - (firstPageOf(b.block) ?? 0) || a.order - b.order);
  const blocks = unordered.map(({ block }) => block);
  const usedIds = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    let id = slug(block.text);
    for (let i = 2; usedIds.has(id); i++) id = `${slug(block.text)}-${i}`;
    usedIds.add(id);
    block.id = id;
  }

  // illustrations: only from native pages, only plausibly-content-sized,
  // inserted after the last block of their (printed) page. Second extract
  // pass pulls bytes for just those pages (scan images would blow the heap).
  const assets = new Map<string, Uint8Array>();
  const nativePageNumbers = new Set(
    reports.filter((r) => r.verdict === "native").map((r) => r.page)
  );
  const images =
    nativePageNumbers.size > 0 ? extractPdf(bytes, { imagePages: nativePageNumbers }).images : [];
  const contentImages = images.filter((img) => img.w >= 24 && img.h >= 24);
  for (const img of insertionOrder(contentImages)) {
    const file = `assets/img-${img.hash}.png`;
    assets.set(file, img.png);
    const printed = printedPages.get(img.page) ?? img.page;
    const idx = blocks.findLastIndex((b) => firstPageOf(b) !== undefined && firstPageOf(b)! <= printed);
    blocks.splice(idx + 1, 0, { type: "image", file, page: printed });
  }

  const language = opts.language ?? "en";
  if (!opts.language) warnings.push(`no language given — defaulting to "en" (use --lang)`);
  const title = opts.title ?? extraction.meta.title;
  if (!title) warnings.push("no title in PDF metadata — pass --title");

  const book: Book = {
    title: title ?? "Untitled",
    language,
    ...(opts.author ?? extraction.meta.author
      ? { author: (opts.author ?? extraction.meta.author)! }
      : {}),
    content: blocks,
    footnotes: {},
  };
  return { book, assets, warnings, report };
}

const firstPageOf = (b: Block): number | undefined => b.page ?? b.pages?.[0]?.page;
const insertionOrder = (images: PdfImage[]) => [...images].sort((a, b) => a.page - b.page || a.y - b.y);
