// The Studio's local HTTP API. Everything below is one of three things: an
// HTTP helper, a request schema, or a handler. Routing is a table at the
// bottom, so adding a route never means editing a chain of conditionals.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { writeEpub } from "../epub/write.js";
import { installModel, modelStatus, removeModel, unloadModel, withModel } from "../models/registry.js";
import { extractPdf, renderPagePng } from "../pdf/extract.js";
import { ocrBlocksToBookBlocks } from "../pdf/ocr.js";
import { OCR_SCALE, pdfToBook } from "../pdf/pdf.js";
import { textlayer, type PageReport } from "../pdf/textlayer.js";
import type { Book } from "../contract.js";

// ---------------------------------------------------------------- state

type Document = {
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
const documents = new Map<string, Document>();

const remember = (document: Document) => {
  documents.set(document.id, document);
  for (const id of [...documents.keys()].slice(0, -MAX_DOCUMENTS)) documents.delete(id);
};

const staticRoot = fileURLToPath(new URL("../../studio/dist/", import.meta.url));

// ---------------------------------------------------------------- http

/** An error with the status it deserves. Anything else is a 500. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const badRequest = (message: string) => new HttpError(400, message);
const notFound = (message: string) => new HttpError(404, message);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sendJson = (res: ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

const sendBytes = (res: ServerResponse, value: Uint8Array, type: string, filename?: string) => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": value.byteLength,
    ...(filename && { "content-disposition": `attachment; filename="${filename.replace(/["\r\n]/g, "")}"` }),
  });
  res.end(value);
};

/**
 * A long job answers with a stream of JSON events rather than one response at
 * the end, which is what makes honest progress possible. The whole job runs
 * inside, validation included: once this is entered every outcome — including
 * a rejected request — reaches the client as an event, never as a status code
 * the client is no longer listening for.
 */
const streamed = async (res: ServerResponse, job: (send: (event: unknown) => void) => Promise<void>) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const send = (event: unknown) => void res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    await job(send);
  } catch (error) {
    send({ type: "error", message: message(error) });
  }
  res.end();
};

const readBody = async (req: IncomingMessage, limit: number): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) throw new HttpError(413, `upload is larger than ${Math.round(limit / 1024 ** 2)} MB`);
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const UPLOAD_LIMIT = 512 * 1024 * 1024;

/** Request bodies are parsed, never trusted: a bad shape is a 400, not a crash. */
const readJson = async <T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> => {
  const raw = await readBody(req, 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw badRequest("request body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw badRequest(parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
};

const TestRequest = z.object({ page: z.number().int().positive() });

const ConvertRequest = z.object({
  pages: z.array(z.number().int().positive()).min(1, "select at least one page"),
  title: z.string().optional(),
  author: z.string().optional(),
  language: z.string().optional(),
});

// ---------------------------------------------------------------- domain

/** A page worth testing on: prefer a scanned, text-heavy page near the middle. */
const suggestedPage = (reports: PageReport[]): number => {
  const middle = (reports.length + 1) / 2;
  const score = (report: PageReport) =>
    (report.verdict === "scanned" ? 100 : 0) +
    Math.min(report.chars, 1200) / 120 -
    Math.abs(report.page - middle) / Math.max(1, reports.length);
  return reports.filter((report) => report.verdict !== "no-text").sort((a, b) => score(b) - score(a))[0]?.page ?? 1;
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

// ---------------------------------------------------------------- handlers

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<void>;

const documentOf = ({ params }: Ctx): Document => {
  const document = documents.get(params.id ?? "");
  if (!document) throw notFound("this document is no longer loaded; add the file again");
  return document;
};

const pageOf = (document: Document, page: number): number => {
  if (!document.reports.some((report) => report.page === page)) throw badRequest(`page ${page} is out of range`);
  return page;
};

const getStatus: Handler = async ({ res }) => {
  sendJson(res, 200, { model: await modelStatus(), hardware: hardware() });
};

const postInstall: Handler = async ({ res }) =>
  await streamed(res, async (send) => {
    const done = await installModel((line) => send({ type: "log", line }));
    send({ type: "done", message: done });
  });

const postUnload: Handler = async ({ res }) => {
  const done = await unloadModel();
  sendJson(res, 200, { message: done, model: await modelStatus() });
};

const postRemove: Handler = async ({ res }) => {
  const done = await removeModel();
  sendJson(res, 200, { message: done, model: await modelStatus() });
};

const postDocument: Handler = async ({ req, res }) => {
  const file = await readBody(req, UPLOAD_LIMIT);
  if (file.byteLength === 0) throw badRequest("that file is empty");
  const name = decodeURIComponent(String(req.headers["x-ocr-compose-filename"] ?? "book.pdf")).replace(/[/\\]/g, "-");
  const extraction = extractPdf(file);
  const { reports, counts } = textlayer(extraction.pages);
  const document: Document = { id: randomUUID(), name, bytes: file, reports };
  remember(document);
  sendJson(res, 200, {
    id: document.id,
    name,
    sizeBytes: file.byteLength,
    pageCount: extraction.pages.length,
    pages: reports,
    counts,
    suggestedPage: suggestedPage(reports),
    title: extraction.meta.title ?? name.replace(/\.pdf$/i, ""),
    author: extraction.meta.author ?? "",
  });
};

const getPageImage: Handler = async (ctx) => {
  const document = documentOf(ctx);
  const page = pageOf(document, Number(ctx.params.page));
  const scale = Math.min(3, Math.max(0.2, Number(ctx.url.searchParams.get("scale") ?? 1)));
  sendBytes(ctx.res, renderPagePng(document.bytes, page, scale), "image/png");
};

/**
 * Recognize one page for real, never from cache, so its duration is an honest
 * per-page cost to project the whole book from. It renders at the conversion's
 * own scale, so the timing matches the work the conversion will do — and the
 * conversion then reuses this page's cached result instead of redoing it.
 */
const postTest: Handler = async (ctx) => {
  const document = documentOf(ctx);
  const page = pageOf(document, (await readJson(ctx.req, TestRequest)).page);
  const png = renderPagePng(document.bytes, page, OCR_SCALE);
  let started = performance.now();
  const regions = await withModel((engine) => {
    started = performance.now(); // loading weights is a one-time cost, not a per-page one
    return engine.recognize(png, [], { fresh: true });
  });
  sendJson(ctx.res, 200, {
    page,
    elapsedMs: Math.round(performance.now() - started),
    regions,
    blocks: ocrBlocksToBookBlocks(regions, page),
  });
};

const postConvert: Handler = async (ctx) =>
  await streamed(ctx.res, async (send) => {
    const document = documentOf(ctx);
    const request = await readJson(ctx.req, ConvertRequest);
    const pages = [...new Set(request.pages)].sort((a, b) => a - b);
    const needsOcr = document.reports.some((report) => pages.includes(report.page) && report.verdict === "scanned");

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
      ? await withModel((engine) => pdfToBook(document.bytes, { ...options, ocr: engine }))
      : await pdfToBook(document.bytes, options);

    send({ type: "stage", stage: "Packing the EPUB" });
    document.book = result.book;
    document.epub = await writeEpub(result.book, result.assets);
    send({
      type: "done",
      stats: {
        blocks: result.book.content.length,
        footnotes: Object.keys(result.book.footnotes).length,
        epubBytes: document.epub.byteLength,
        counts: result.report.counts,
      },
      warnings: result.warnings,
    });
  });

const getEpub: Handler = async (ctx) => {
  const document = documentOf(ctx);
  if (!document.epub) throw notFound("nothing converted yet");
  sendBytes(ctx.res, document.epub, "application/epub+zip", `${document.name.replace(/\.pdf$/i, "")}.epub`);
};

const getBookJson: Handler = async (ctx) => {
  const document = documentOf(ctx);
  if (!document.book) throw notFound("nothing converted yet");
  const body = new TextEncoder().encode(JSON.stringify(document.book, null, 2) + "\n");
  sendBytes(ctx.res, body, "application/json", `${document.name.replace(/\.pdf$/i, "")}.book.json`);
};

// ---------------------------------------------------------------- routing

const DOC = String.raw`(?<id>[0-9a-f-]{36})`;

const routes: { method: string; path: RegExp; handler: Handler }[] = [
  { method: "GET", path: /^\/api\/status$/, handler: getStatus },
  { method: "POST", path: /^\/api\/model\/install$/, handler: postInstall },
  { method: "POST", path: /^\/api\/model\/unload$/, handler: postUnload },
  { method: "POST", path: /^\/api\/model\/remove$/, handler: postRemove },
  { method: "POST", path: /^\/api\/documents$/, handler: postDocument },
  { method: "GET", path: new RegExp(String.raw`^/api/documents/${DOC}/pages/(?<page>\d+)\.png$`), handler: getPageImage },
  { method: "POST", path: new RegExp(String.raw`^/api/documents/${DOC}/test$`), handler: postTest },
  { method: "POST", path: new RegExp(String.raw`^/api/documents/${DOC}/convert$`), handler: postConvert },
  { method: "GET", path: new RegExp(String.raw`^/api/documents/${DOC}/epub$`), handler: getEpub },
  { method: "GET", path: new RegExp(String.raw`^/api/documents/${DOC}/book\.json$`), handler: getBookJson },
];

const match = (method: string, pathname: string) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const found = route.path.exec(pathname);
    if (found) return { handler: route.handler, params: found.groups ?? {} };
  }
  return null;
};

const sendStaticFile = async (res: ServerResponse, pathname: string) => {
  const path = normalize(join(staticRoot, pathname === "/" ? "index.html" : pathname.slice(1)));
  if (!path.startsWith(staticRoot)) throw new HttpError(403, "forbidden");
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  const file = await readFile(path).catch(() => {
    throw notFound("not found");
  });
  sendBytes(res, new Uint8Array(file), contentTypes[extname(path)] ?? "application/octet-stream");
};

export async function startStudio(options: { host?: string; port?: number } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!url.pathname.startsWith("/api/")) return await sendStaticFile(res, url.pathname);
      const route = match(req.method ?? "GET", url.pathname);
      if (!route) throw notFound(`no API route for ${req.method} ${url.pathname}`);
      await route.handler({ req, res, url, params: route.params });
    } catch (error) {
      // A streaming handler has already reported its own failure as an event.
      if (res.headersSent) return void res.end();
      sendJson(res, error instanceof HttpError ? error.status : 500, { error: message(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://${address.address}:${address.port}` };
}
