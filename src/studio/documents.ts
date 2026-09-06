// The uploaded files this process is holding, and what has been made from them.
// A PDF arrives raw and gets converted; an EPUB or a book.json arrives as an
// already-made book and goes straight to review — the same block editor, the
// same validation, the same re-pack.
import { randomUUID } from "node:crypto";
import { validateBook, type Book } from "../contract.js";
import { readEpub } from "../epub/read.js";
import { writeEpub } from "../epub/write.js";
import { extractPdf } from "../pdf/extract.js";
import { textlayer, type PageReport } from "../pdf/textlayer.js";
import { badRequest, notFound } from "./errors.js";

export type StudioDocument = {
  id: string;
  name: string;
  /** `pdf` converts; `book` (from an EPUB or a book.json) reviews and packs. */
  kind: "pdf" | "book";
  bytes: Uint8Array;
  reports: PageReport[];
  book?: Book;
  /** The images the conversion produced, kept so the book can be reviewed and re-packed. */
  assets?: Map<string, Uint8Array>;
  epub?: Uint8Array;
};

/**
 * A document holds a whole PDF — and later its EPUB — in memory, so only the
 * few most recent are kept alive. A local tool converts one book at a time.
 */
const MAX_DOCUMENTS = 3;
const documents = new Map<string, StudioDocument>();

/** A page worth testing on: prefer a scanned, text-heavy page near the middle. */
const suggestedPage = (reports: PageReport[]): number => {
  const middle = (reports.length + 1) / 2;
  const score = (report: PageReport) =>
    (report.verdict === "scanned" ? 100 : 0) +
    Math.min(report.chars, 1200) / 120 -
    Math.abs(report.page - middle) / Math.max(1, reports.length);
  return reports.filter((report) => report.verdict !== "no-text").sort((a, b) => score(b) - score(a))[0]?.page ?? 1;
};

const keep = (document: StudioDocument) => {
  documents.set(document.id, document);
  for (const id of [...documents.keys()].slice(0, -MAX_DOCUMENTS)) documents.delete(id);
};

const summarize = (document: StudioDocument, counts: Record<string, number>, title: string, author: string) => ({
  id: document.id,
  name: document.name,
  kind: document.kind,
  sizeBytes: document.bytes.byteLength,
  pageCount: document.reports.length,
  pages: document.reports,
  counts,
  suggestedPage: suggestedPage(document.reports),
  title,
  author,
});

/** Reads an uploaded file — PDF, EPUB, or book.json — and keeps it for the run. */
export async function addDocument(name: string, bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw badRequest("that file is empty");

  // EPUB is a zip ("PK"), so the sniff never mistakes one for a PDF ("%PDF").
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const { book, assets } = await readEpub(bytes).catch((error: unknown) => {
      throw badRequest(`could not read that EPUB: ${error instanceof Error ? error.message : String(error)}`);
    });
    return fromBook(name, bytes, book, assets, bytes);
  }

  if (bytes[0] === 0x7b /* "{" */ || /\.json$/i.test(name)) {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw badRequest("that file is not valid JSON");
    }
    const issues = validateBook(raw);
    if (issues.length > 0)
      throw badRequest("not a valid book.json: " + issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    // A bare book.json carries no image bytes, and the packer refuses holes —
    // so a book with images must arrive as its EPUB, which carries them.
    return fromBook(name, bytes, raw as Book, new Map()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/referenced asset missing/.test(message))
        throw badRequest(
          `this book.json references image bytes it does not carry (${message.split(": ")[1] ?? "assets"}) — ` +
            "upload the EPUB instead, which does",
        );
      throw error;
    });
  }

  const extraction = extractPdf(bytes);
  const { reports, counts } = textlayer(extraction.pages);
  const document: StudioDocument = { id: randomUUID(), name, kind: "pdf", bytes, reports };
  keep(document);
  return {
    document,
    summary: summarize(document, counts, extraction.meta.title ?? name.replace(/\.pdf$/i, ""), extraction.meta.author ?? ""),
  };
}

async function fromBook(name: string, bytes: Uint8Array, book: Book, assets: Map<string, Uint8Array>, epub?: Uint8Array) {
  const document: StudioDocument = {
    id: randomUUID(),
    name,
    kind: "book",
    bytes,
    reports: [],
    book,
    assets,
    epub: epub ?? (await writeEpub(book, assets)),
  };
  keep(document);
  return {
    document,
    summary: summarize(document, { native: 0, scanned: 0, "no-text": 0 }, book.title, book.author ?? ""),
  };
}

export function getDocument(id: string): StudioDocument {
  const document = documents.get(id);
  if (!document) throw notFound("this document is no longer loaded; add the file again");
  return document;
}

/** The routes that render, test and convert pages only make sense for a PDF. */
export function requirePdf(document: StudioDocument): StudioDocument {
  if (document.kind !== "pdf") throw badRequest("this document is a book, not a PDF — review and download it instead");
  return document;
}

export function requirePage(document: StudioDocument, page: number): number {
  if (!document.reports.some((report) => report.page === page)) throw badRequest(`page ${page} is out of range`);
  return page;
}

/** `frankenstein.pdf` → `frankenstein.epub`. */
export const downloadName = (document: StudioDocument, extension: string) =>
  `${document.name.replace(/\.(pdf|epub|json)$/i, "")}.${extension}`;
