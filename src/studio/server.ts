import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { validateBook, type Book } from "../contract.js";
import { readEpub } from "../epub/read.js";
import { writeEpub } from "../epub/write.js";
import { installModel, listModels, removeModel, unloadModel, withModel } from "../models/registry.js";
import { extractPdf, renderPagePng } from "../pdf/extract.js";
import { ocrBlocksToBookBlocks, type OcrEngine } from "../pdf/ocr.js";
import { pdfToBook } from "../pdf/pdf.js";
import { textlayer, type PageReport } from "../pdf/textlayer.js";

type Conversion = { assets: Map<string, Uint8Array> };
type DocumentSession = {
  id: string;
  name: string;
  kind: "pdf" | "epub";
  bytes: Uint8Array;
  reports?: PageReport[];
  book?: Book;
  assets?: Map<string, Uint8Array>;
  conversions: Map<string, Conversion>;
};

const sessions = new Map<string, DocumentSession>();
const staticRoot = fileURLToPath(new URL("../../studio/dist/", import.meta.url));
const sessionRoot = () => join(process.cwd(), ".bookforge-studio", "sessions");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
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

const bytes = (res: ServerResponse, status: number, value: Uint8Array, type: string, filename?: string) => {
  res.writeHead(status, {
    "content-type": type,
    "content-length": value.byteLength,
    ...(filename && { "content-disposition": `attachment; filename="${filename.replace(/["\r\n]/g, "")}"` }),
  });
  res.end(value);
};

const body = async (req: IncomingMessage, limit = 512 * 1024 * 1024): Promise<Uint8Array> => {
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

const bodyJson = async <T>(req: IncomingMessage): Promise<T> => {
  const raw = await body(req, 10 * 1024 * 1024);
  return JSON.parse(new TextDecoder().decode(raw)) as T;
};

const suggestedPage = (reports: PageReport[]): number => {
  const middle = (reports.length + 1) / 2;
  const candidates = reports.filter((report) => report.verdict !== "no-text");
  return (
    candidates.sort((a, b) => {
      const score = (report: PageReport) =>
        (report.verdict === "scanned" ? 100 : 0) +
        Math.min(report.chars, 1200) / 120 -
        Math.abs(report.page - middle) / Math.max(1, reports.length);
      return score(b) - score(a);
    })[0]?.page ?? 1
  );
};

const safeSession = (id: string): DocumentSession => {
  const session = sessions.get(id);
  if (!session) throw new Error("document session not found; upload the file again");
  return session;
};

const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
  if (req.method === "GET" && url.pathname === "/api/models") {
    json(res, 200, { models: await listModels() });
    return true;
  }

  // install = put on disk, unload = free memory now, remove = delete from disk.
  const modelMatch = /^\/api\/models\/([^/]+)\/(install|unload|remove)$/.exec(url.pathname);
  if (req.method === "POST" && modelMatch) {
    const id = decodeURIComponent(modelMatch[1]!);
    const action = { install: installModel, unload: unloadModel, remove: removeModel }[modelMatch[2]!]!;
    const result = await action(id);
    json(res, 200, { ...result, models: await listModels() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/documents") {
    const file = await body(req);
    if (file.byteLength === 0) throw new Error("the uploaded file is empty");
    const encodedName = String(req.headers["x-bookforge-filename"] ?? "book.pdf");
    const name = decodeURIComponent(encodedName).replace(/[\/\\]/g, "-");
    const kind = name.toLowerCase().endsWith(".epub") ? "epub" : "pdf";
    const id = randomUUID();
    const session: DocumentSession = { id, name, kind, bytes: file, conversions: new Map() };
    await mkdir(sessionRoot(), { recursive: true });
    await writeFile(join(sessionRoot(), `${id}.${kind}`), file);

    if (kind === "epub") {
      const parsed = await readEpub(file);
      session.book = parsed.book;
      session.assets = parsed.assets;
      sessions.set(id, session);
      json(res, 200, {
        document: { id, name, kind, pageCount: 0, pages: [], suggestedPage: null },
        book: parsed.book,
        warnings: parsed.warnings,
      });
      return true;
    }

    const extraction = extractPdf(file);
    const { reports, counts } = textlayer(extraction.pages);
    session.reports = reports;
    sessions.set(id, session);
    json(res, 200, {
      document: {
        id,
        name,
        kind,
        pageCount: extraction.pages.length,
        pages: reports,
        counts,
        suggestedPage: suggestedPage(reports),
        title: extraction.meta.title,
        author: extraction.meta.author,
      },
    });
    return true;
  }

  const assetMatch = /^\/api\/documents\/([^/]+)\/assets\/(.+)$/.exec(url.pathname);
  if (req.method === "GET" && assetMatch) {
    const session = safeSession(assetMatch[1]!);
    const path = decodeURIComponent(assetMatch[2]!);
    const conversionId = url.searchParams.get("conversionId");
    const assets = (conversionId && session.conversions.get(conversionId)?.assets) || session.assets;
    const value = assets?.get(path);
    if (!value) throw new Error(`asset not found: ${path}`);
    bytes(res, 200, value, contentTypes[extname(path)] ?? "application/octet-stream");
    return true;
  }

  const pageMatch = /^\/api\/documents\/([^/]+)\/pages\/(\d+)\.png$/.exec(url.pathname);
  if (req.method === "GET" && pageMatch) {
    const session = safeSession(pageMatch[1]!);
    if (session.kind !== "pdf") throw new Error("page rendering is only available for PDFs");
    const page = Number(pageMatch[2]);
    if (!session.reports?.some((report) => report.page === page)) throw new Error("page is out of range");
    const scale = Math.min(3, Math.max(0.5, Number(url.searchParams.get("scale") ?? 1)));
    bytes(res, 200, renderPagePng(session.bytes, page, scale), "image/png");
    return true;
  }

  const compareMatch = /^\/api\/documents\/([^/]+)\/compare$/.exec(url.pathname);
  if (req.method === "POST" && compareMatch) {
    const session = safeSession(compareMatch[1]!);
    if (session.kind !== "pdf") throw new Error("model comparison is only available for PDFs");
    const request = await bodyJson<{ page: number; modelIds: string[] }>(req);
    if (!session.reports?.some((report) => report.page === request.page)) throw new Error("sample page is out of range");
    const pagePng = renderPagePng(session.bytes, request.page, 2);
    const results = [];
    // Sequential on purpose: one model is resident at a time. Engines stay warm
    // afterwards, so the convert that follows reuses the loaded weights.
    for (const modelId of request.modelIds) {
      const started = performance.now();
      try {
        const blocks = await withModel(modelId, (engine) => engine.recognize(pagePng, []));
        results.push({
          modelId,
          ok: true,
          elapsedMs: Math.round(performance.now() - started),
          blocks,
          contractBlocks: ocrBlocksToBookBlocks(blocks, request.page),
        });
      } catch (error) {
        results.push({
          modelId,
          ok: false,
          elapsedMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    json(res, 200, { page: request.page, results });
    return true;
  }

  const convertMatch = /^\/api\/documents\/([^/]+)\/convert$/.exec(url.pathname);
  if (req.method === "POST" && convertMatch) {
    const session = safeSession(convertMatch[1]!);
    if (session.kind !== "pdf") throw new Error("this document is already editable");
    const request = await bodyJson<{
      pages: number[];
      modelId?: string;
      title?: string;
      author?: string;
      language?: string;
    }>(req);
    const selected = [...new Set(request.pages)].sort((a, b) => a - b);
    if (selected.length === 0) throw new Error("select at least one page");
    const selectedReports = session.reports?.filter((report) => selected.includes(report.page)) ?? [];
    const needsOcr = selectedReports.some((report) => report.verdict === "scanned");
    const convert = async (engine?: OcrEngine) =>
      await pdfToBook(session.bytes, {
        pages: selected,
        ...(request.title && { title: request.title }),
        ...(request.author && { author: request.author }),
        language: request.language || "en",
        ...(engine && { ocr: engine }),
      });
    // The model stays loaded for the whole conversion and idles out afterwards.
    const result = needsOcr ? await withModel(request.modelId ?? "", convert) : await convert();
    const conversionId = randomUUID();
    session.conversions.set(conversionId, { assets: result.assets });
    json(res, 200, {
      conversionId,
      book: result.book,
      warnings: result.warnings,
      report: result.report,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/validate") {
    const request = await bodyJson<{ book: unknown }>(req);
    json(res, 200, { issues: validateBook(request.book) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/export/epub") {
    const request = await bodyJson<{ documentId: string; conversionId?: string; book: unknown }>(req);
    const issues = validateBook(request.book);
    if (issues.length > 0) {
      json(res, 422, { error: "Book contract is invalid", issues });
      return true;
    }
    const session = safeSession(request.documentId);
    const assets = request.conversionId
      ? session.conversions.get(request.conversionId)?.assets
      : session.assets;
    if (!assets) throw new Error("conversion assets are no longer available; convert the document again");
    const epub = await writeEpub(request.book as Book, assets);
    const filename = session.name.replace(/\.(pdf|epub)$/i, "") + "-bookforge.epub";
    bytes(res, 200, epub, "application/epub+zip", filename);
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
    const value = new Uint8Array(await readFile(path));
    bytes(res, 200, value, contentTypes[extname(path)] ?? "application/octet-stream");
  } catch {
    json(res, 404, { error: "not found" });
  }
};

export async function startStudio(options: { host?: string; port?: number } = {}) {
  await mkdir(sessionRoot(), { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        if (!(await api(req, res, url))) json(res, 404, { error: "API route not found" });
      } else await staticFile(res, url.pathname);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://${address.address}:${address.port}` };
}
