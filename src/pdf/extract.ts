// PDF → typed page data (DESIGN.md tool 3, `extract`). The native path reads
// the file's own structure: text spans with real font names (italic is a
// string, never an inference — §5.1), grouped into visual lines by baseline.
// Geometry lives only here and in the passes; it never reaches book.json (I2).
import * as mupdf from "mupdf";
import { createHash } from "node:crypto";

export type PdfRun = {
  text: string;
  font: string;
  size: number;
  italic: boolean;
  bold: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type PdfLine = {
  runs: PdfRun[];
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  /** set by classify: running headers/footers/page numbers (I3: demoted, not deleted) */
  role?: "furniture";
};
export type PdfImage = { page: number; x: number; y: number; w: number; h: number; png: Uint8Array; hash: string };
export type PdfBookmark = { title: string; page: number; level: number };
export type PdfPage = {
  page: number; // 1-based PDF page index
  width: number;
  height: number;
  lines: PdfLine[];
  /** fraction of the page area covered by images (textlayer signal) */
  imageCoverage: number;
  fonts: Set<string>;
};
export type PdfExtraction = {
  pages: PdfPage[];
  images: PdfImage[];
  bookmarks: PdfBookmark[];
  meta: { title?: string; author?: string };
};

const ITALIC = /italic|oblique|-it\b|-ital\b/i;
const BOLD = /bold|black|heavy|-bd\b|semib/i;

type StextLine = {
  text: string;
  font: { name: string; size: number };
  bbox: { x: number; y: number; w: number; h: number };
};

/** Group per-style spans into visual lines by baseline proximity. */
function groupLines(spans: StextLine[], page: number): PdfLine[] {
  const runs: PdfRun[] = spans.map((s) => ({
    text: s.text,
    font: s.font.name,
    size: s.font.size,
    italic: ITALIC.test(s.font.name),
    bold: BOLD.test(s.font.name),
    x: s.bbox.x,
    y: s.bbox.y,
    w: s.bbox.w,
    h: s.bbox.h,
  }));
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const run of runs) {
    const line = lines.at(-1);
    if (line && Math.abs(run.y - line.y) < Math.max(run.size, 6) * 0.5) {
      line.runs.push(run);
      const x1 = Math.max(line.x + line.w, run.x + run.w);
      line.x = Math.min(line.x, run.x);
      line.w = x1 - line.x;
      line.h = Math.max(line.h, run.h);
    } else {
      lines.push({ runs: [run], x: run.x, y: run.y, w: run.w, h: run.h, page });
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines;
}

export type PageRender = {
  png: Uint8Array;
  width: number;
  height: number;
  /** Crop a normalized region (top-left origin, 0..1) out of the same pixmap. */
  crop(x: number, y: number, w: number, h: number): Uint8Array | null;
};

/**
 * Render one page (1-based) once — the PNG the OCR adapter reads, plus region
 * crops taken from that same pixmap, so a figure on a scanned page costs no
 * second render.
 */
export function renderPage(bytes: Uint8Array, pageNo: number, scale = 2): PageRender {
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(pageNo - 1);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB);
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  return {
    png: pixmap.asPNG(),
    width,
    height,
    crop(x, y, w, h) {
      const x0 = Math.max(0, Math.round(x * width));
      const y0 = Math.max(0, Math.round(y * height));
      const x1 = Math.min(width, Math.round((x + w) * width));
      const y1 = Math.min(height, Math.round((y + h) * height));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;
      // an axis-aligned warp of the rendered pixmap is a straight crop
      return pixmap
        .warp([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], x1 - x0, y1 - y0)
        .asPNG();
    },
  };
}

/** Render one page (1-based) to PNG — input for the OCR adapter. */
export function renderPagePng(bytes: Uint8Array, pageNo: number, scale = 2): Uint8Array {
  return renderPage(bytes, pageNo, scale).png;
}

export function extractPdf(
  bytes: Uint8Array,
  // image BYTES are pulled only for the listed pages — decoding every page
  // image of a scanned book overruns the WASM heap (P6); the textlayer
  // verdict must come first, then a second pass fetches what's needed
  opts: { imagePages?: Set<number> } = {}
): PdfExtraction {
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  const pages: PdfPage[] = [];
  const images: PdfImage[] = [];
  const seenImages = new Set<string>();

  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const [px0, py0, px1, py1] = page.getBounds();
    const width = px1 - px0;
    const height = py1 - py0;

    const stext = JSON.parse(page.toStructuredText("preserve-spans").asJSON()) as {
      blocks?: { lines?: StextLine[] }[];
    };
    const spans = (stext.blocks ?? []).flatMap((b) => b.lines ?? []).filter((l) => l.text.length > 0);
    const lines = groupLines(spans, i + 1);
    const fonts = new Set(spans.map((s) => s.font.name));

    let imageArea = 0;
    page.toStructuredText("preserve-images").walk({
      onImageBlock(bbox: [number, number, number, number], _transform: unknown, image: { toPixmap(): { asPNG(): Uint8Array } }) {
        const [x0, y0, x1, y1] = bbox;
        imageArea += Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        if (!opts.imagePages?.has(i + 1)) return;
        const png = image.toPixmap().asPNG();
        const hash = createHash("sha1").update(png).digest("hex").slice(0, 16);
        if (!seenImages.has(hash + ":" + (i + 1))) {
          seenImages.add(hash + ":" + (i + 1));
          images.push({ page: i + 1, x: x0, y: y0, w: x1 - x0, h: y1 - y0, png, hash });
        }
      },
    });

    pages.push({ page: i + 1, width, height, lines, imageCoverage: Math.min(1, imageArea / (width * height)), fonts });
  }

  const bookmarks: PdfBookmark[] = [];
  const walkOutline = (items: { title?: string; uri?: string; down?: unknown[] }[] | null, level: number) => {
    for (const item of items ?? []) {
      try {
        const dest = doc.resolveLinkDestination(item.uri ?? "");
        if (dest.page >= 0) bookmarks.push({ title: item.title ?? "", page: dest.page + 1, level });
      } catch {
        /* unresolvable bookmark — skip */
      }
      walkOutline((item.down ?? null) as never, level + 1);
    }
  };
  walkOutline(doc.loadOutline() as never, 1);

  const meta: PdfExtraction["meta"] = {};
  const title = doc.getMetaData("info:Title");
  const author = doc.getMetaData("info:Author");
  if (title) meta.title = title;
  if (author) meta.author = author;

  return { pages, images, bookmarks, meta };
}
