// The uploaded PDFs this process is holding, and what has been made from them.
import { randomUUID } from "node:crypto";
import type { Book } from "../contract.js";
import { extractPdf } from "../pdf/extract.js";
import { textlayer, type PageReport } from "../pdf/textlayer.js";
import { badRequest, notFound } from "./errors.js";

export type StudioDocument = {
  id: string;
  name: string;
  bytes: Uint8Array;
  reports: PageReport[];
  book?: Book;
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

/** Reads a PDF, classifies every page, and keeps it for the rest of the run. */
export function addDocument(name: string, bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw badRequest("that file is empty");
  const extraction = extractPdf(bytes);
  const { reports, counts } = textlayer(extraction.pages);
  const document: StudioDocument = { id: randomUUID(), name, bytes, reports };

  documents.set(document.id, document);
  for (const id of [...documents.keys()].slice(0, -MAX_DOCUMENTS)) documents.delete(id);

  return {
    document,
    summary: {
      id: document.id,
      name,
      sizeBytes: bytes.byteLength,
      pageCount: extraction.pages.length,
      pages: reports,
      counts,
      suggestedPage: suggestedPage(reports),
      title: extraction.meta.title ?? name.replace(/\.pdf$/i, ""),
      author: extraction.meta.author ?? "",
    },
  };
}

export function getDocument(id: string): StudioDocument {
  const document = documents.get(id);
  if (!document) throw notFound("this document is no longer loaded; add the file again");
  return document;
}

export function requirePage(document: StudioDocument, page: number): number {
  if (!document.reports.some((report) => report.page === page)) throw badRequest(`page ${page} is out of range`);
  return page;
}

/** `frankenstein.pdf` → `frankenstein.epub`. */
export const downloadName = (document: StudioDocument, extension: string) =>
  `${document.name.replace(/\.pdf$/i, "")}.${extension}`;
