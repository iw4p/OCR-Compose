import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Block, Book } from "../contract.js";
import { writeEpub } from "../epub/write.js";
import { installModel, modelStatus, removeModel, unloadModel, withModel } from "../models/registry.js";
import { extractPdf, renderPagePng } from "../pdf/extract.js";
import { ocrBlocksToBookBlocks, type OcrBlock } from "../pdf/ocr.js";
import { OCR_SCALE, pdfToBook } from "../pdf/pdf.js";
import { textlayer, type PageReport } from "../pdf/textlayer.js";

type Session = {
  id: string;
  name: string;
  bytes: Uint8Array;
  reports: PageReport[];
  book?: Book;
  epub?: Uint8Array;
};

const sessions = new Map<string, Session>();
const staticRoot = fileURLToPath(new URL("../../studio/dist/", import.meta.url));

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const json = (res: ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

const bytes = (res: ServerResponse, value: Uint8Array, type: string, filename?: string) => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": value.byteLength,
    ...(filename && { "content-disposition": `attachment; filename="${filename.replace(/["\r\n]/g, "")}"` }),
  });
  res.end(value);
};

/** One JSON event per line, so a long job can report progress while it runs. */
const stream = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
};

/** Runs a streaming job, reporting a failure as the stream's last event. */
const streamed = async (res: ServerResponse, job: (send: (event: unknown) => void) => Promise<void>) => {
  const send = stream(res);
  try {
    await job(send);
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
  res.end();
};

const readBody = async (req: IncomingMessage, limit = 512 * 1024 * 1024): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) throw new Error("upload is larger than 512 MB");
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const readJson = async <T>(req: IncomingMessage): Promise<T> =>
  JSON.parse(new TextDecoder().decode(await readBody(req, 1024 * 1024))) as T;

/** A page worth testing on: prefer a scanned, text-heavy page near the middle. */
const suggestedPage = (reports: PageReport[]): number => {
  const middle = (reports.length + 1) / 2;
  const score = (report: PageReport) =>
    (report.verdict === "scanned" ? 100 : 0) +
    Math.min(report.chars, 1200) / 120 -
    Math.abs(report.page - middle) / Math.max(1, reports.length);
  return (
    reports
      .filter((report) => report.verdict !== "no-text")
      .sort((a, b) => score(b) - score(a))[0]?.page ?? 1
  );
};

const session = (id: string): Session => {
  const found = sessions.get(id);
  if (!found) throw new Error("this document is no longer loaded; add the file again");
  return found;
};

const hardware = () => {
  const cores = cpus();
  return {
    cpu: cores[0]?.model.replace(/\s+/g, " ").trim() ?? "unknown CPU",
    cores: cores.length,
    memoryBytes: totalmem(),
    platform: `${process.platform}/${process.arch}`,
  };
};

const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
  const post = req.method === "POST";
  const get = req.method === "GET";

  if (get && url.pathname === "/api/status") {
    json(res, 200, { model: await modelStatus(), hardware: hardware() });
    return true;
  }

  if (post && url.pathname === "/api/model/install") {
    await streamed(res, async (send) => {
      const message = await installModel((line) => send({ type: "log", line }));
      send({ type: "done", message, model: await modelStatus() });
    });
    return true;
  }

  if (post && (url.pathname === "/api/model/unload" || url.pathname === "/api/model/remove")) {
    const message = url.pathname.endsWith("remove") ? await removeModel() : await unloadModel();
    json(res, 200, { message, model: await modelStatus() });
    return true;
  }

  if (post && url.pathname === "/api/documents") {
    const file = await readBody(req);
    if (file.byteLength === 0) throw new Error("that file is empty");
    const name = decodeURIComponent(String(req.headers["x-ocr-compose-filename"] ?? "book.pdf")).replace(/[\/\\]/g, "-");
    const extraction = extractPdf(file);
    const { reports, counts } = textlayer(extraction.pages);
    const id = randomUUID();
    sessions.set(id, { id, name, bytes: file, reports });
    json(res, 200, {
      id,
      name,
      sizeBytes: file.byteLength,
      pageCount: extraction.pages.length,
      pages: reports,
      counts,
      suggestedPage: suggestedPage(reports),
      title: extraction.meta.title ?? name.replace(/\.pdf$/i, ""),
      author: extraction.meta.author ?? "",
    });
    return true;
  }

  const pageMatch = /^\/api\/documents\/([^/]+)\/pages\/(\d+)\.png$/.exec(url.pathname);
  if (get && pageMatch) {
    const doc = session(pageMatch[1]!);
    const page = Number(pageMatch[2]);
    if (!doc.reports.some((report) => report.page === page)) throw new Error("page is out of range");
    const scale = Math.min(3, Math.max(0.2, Number(url.searchParams.get("scale") ?? 1)));
    bytes(res, renderPagePng(doc.bytes, page, scale), "image/png");
    return true;
  }

  // The test run: recognize one page for real (never from cache) so its
  // duration is an honest per-page cost to project the whole book from. It
  // renders at the conversion's own scale, so the timing matches the work the
  // conversion will do and the conversion reuses this page's cached result.
  const testMatch = /^\/api\/documents\/([^/]+)\/test$/.exec(url.pathname);
  if (post && testMatch) {
    const doc = session(testMatch[1]!);
    const { page } = await readJson<{ page: number }>(req);
    if (!doc.reports.some((report) => report.page === page)) throw new Error("page is out of range");
    const png = renderPagePng(doc.bytes, page, OCR_SCALE);
    let started = performance.now();
    const raw = await withModel((engine) => {
      started = performance.now(); // loading weights is a one-time cost, not per page
      return engine.recognize(png, [], { fresh: true });
    });
    json(res, 200, {
      page,
      elapsedMs: Math.round(performance.now() - started),
      regions: raw as OcrBlock[],
      blocks: ocrBlocksToBookBlocks(raw, page) as Block[],
    });
    return true;
  }

  const convertMatch = /^\/api\/documents\/([^/]+)\/convert$/.exec(url.pathname);
  if (post && convertMatch) {
    const doc = session(convertMatch[1]!);
    const request = await readJson<{ pages: number[]; title?: string; author?: string; language?: string }>(req);
    const pages = [...new Set(request.pages)].sort((a, b) => a - b);
    if (pages.length === 0) throw new Error("select at least one page");
    const needsOcr = doc.reports.some((report) => pages.includes(report.page) && report.verdict === "scanned");
    await streamed(res, async (send) => {
      send({ type: "stage", stage: needsOcr ? "Loading the model" : "Reading pages" });
      const options = {
        pages,
        ...(request.title && { title: request.title }),
        ...(request.author && { author: request.author }),
        language: request.language || "en",
        onProgress: (done: number, total: number) =>
          send({ type: "progress", stage: "Recognizing scanned pages", done, total }),
      };
      const result = needsOcr
        ? await withModel((engine) => pdfToBook(doc.bytes, { ...options, ocr: engine }))
        : await pdfToBook(doc.bytes, options);
      send({ type: "stage", stage: "Packing the EPUB" });
      doc.book = result.book;
      doc.epub = await writeEpub(result.book, result.assets);
      send({
        type: "done",
        stats: {
          blocks: result.book.content.length,
          footnotes: Object.keys(result.book.footnotes).length,
          epubBytes: doc.epub.byteLength,
          counts: result.report.counts,
        },
        warnings: result.warnings,
      });
    });
    return true;
  }

  const downloadMatch = /^\/api\/documents\/([^/]+)\/(epub|book\.json)$/.exec(url.pathname);
  if (get && downloadMatch) {
    const doc = session(downloadMatch[1]!);
    const base = doc.name.replace(/\.pdf$/i, "");
    if (downloadMatch[2] === "epub") {
      if (!doc.epub) throw new Error("nothing converted yet");
      bytes(res, doc.epub, "application/epub+zip", `${base}.epub`);
    } else {
      if (!doc.book) throw new Error("nothing converted yet");
      const body = new TextEncoder().encode(JSON.stringify(doc.book, null, 2) + "\n");
      bytes(res, body, "application/json", `${base}.book.json`);
    }
    return true;
  }

  return false;
};

const staticFile = async (res: ServerResponse, pathname: string) => {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(staticRoot, requested));
  if (!path.startsWith(staticRoot)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  try {
    bytes(res, new Uint8Array(await readFile(path)), contentTypes[extname(path)] ?? "application/octet-stream");
  } catch {
    json(res, 404, { error: "not found" });
  }
};

export async function startStudio(options: { host?: string; port?: number } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        if (!(await api(req, res, url))) json(res, 404, { error: "API route not found" });
      } else await staticFile(res, url.pathname);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://${address.address}:${address.port}` };
}
