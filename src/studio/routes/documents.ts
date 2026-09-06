import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { validateBook, type Book } from "../../contract.js";
import { writeEpub } from "../../epub/write.js";
import { withModel } from "../../models/registry.js";
import { renderPagePng } from "../../pdf/extract.js";
import { ocrBlocksToBookBlocks } from "../../pdf/ocr.js";
import { OCR_SCALE, pdfToBook } from "../../pdf/pdf.js";
import { addDocument, downloadName, getDocument, requirePage, requirePdf } from "../documents.js";
import { badRequest, notFound } from "../errors.js";
import { AssetParams, BookBody, ConvertBody, DocumentParams, PageParams, PageQuery, TestBody, parse } from "../schemas.js";
import { stream } from "../stream.js";

/** 512 MB: the whole PDF is read into memory, and books get big. */
const UPLOAD_LIMIT = 512 * 1024 * 1024;

export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post("/api/documents", { bodyLimit: UPLOAD_LIMIT }, async (request) => {
    const name = decodeURIComponent(String(request.headers["x-ocr-compose-filename"] ?? "book.pdf")).replace(
      /[/\\]/g,
      "-",
    );
    // Most uploads arrive as raw bytes via the catch-all parser; a book.json
    // sent as application/json arrives already parsed by Fastify's own JSON
    // parser, so it is put back into bytes for the one sniffing entry point.
    const body: unknown = request.body;
    const bytes = Buffer.isBuffer(body)
      ? new Uint8Array(body)
      : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
    return (await addDocument(name, bytes)).summary;
  });

  app.get("/api/documents/:id/pages/:page.png", { schema: { params: PageParams, querystring: PageQuery } }, async (request, reply) => {
    const document = requirePdf(getDocument(request.params.id));
    const page = requirePage(document, request.params.page);
    return reply.type("image/png").send(renderPagePng(document.bytes, page, request.query.scale));
  });

  /**
   * Recognize one page for real, never from cache, so its duration is an honest
   * per-page cost to project the whole book from. It renders at the conversion's
   * own scale, so the timing matches the work the conversion will do — and the
   * conversion then reuses this page's cached result instead of redoing it.
   */
  app.post("/api/documents/:id/test", { schema: { params: DocumentParams, body: TestBody } }, async (request) => {
    const document = requirePdf(getDocument(request.params.id));
    const page = requirePage(document, request.body.page);
    const png = renderPagePng(document.bytes, page, OCR_SCALE);
    let started = performance.now();
    const regions = await withModel((engine) => {
      started = performance.now(); // loading weights is a one-time cost, not a per-page one
      return engine.recognize(png, [], { fresh: true });
    });
    return {
      page,
      elapsedMs: Math.round(performance.now() - started),
      regions,
      blocks: ocrBlocksToBookBlocks(regions, page),
    };
  });

  // Deliberately schema-less: this route streams, so it validates its own body
  // inside the stream where a rejection can reach the client. See schemas.parse.
  app.post("/api/documents/:id/convert", async (request, reply) =>
    stream(reply, async (send) => {
      const document = requirePdf(getDocument(parse(DocumentParams, request.params).id));
      const body = parse(ConvertBody, request.body);
      const pages = [...new Set(body.pages)].sort((a, b) => a - b);
      const needsOcr = document.reports.some(
        (report) =>
          pages.includes(report.page) &&
          (report.verdict === "scanned" || (body.ocrAll && report.verdict === "native")),
      );

      send({ type: "stage", stage: needsOcr ? "Loading the model" : "Reading pages" });
      const options = {
        pages,
        ...(body.title && { title: body.title }),
        ...(body.author && { author: body.author }),
        language: body.language,
        ...(body.ocrAll && { ocrAll: true }),
        // each recognized page streams to the client before the count ticks,
        // so the UI can show what was just read, not only that something was
        onPage: (page: number, regions: unknown, blocks: unknown) =>
          send({ type: "page", page, regions, blocks }),
        onProgress: (done: number, total: number) =>
          send({ type: "progress", stage: body.ocrAll ? "Recognizing pages" : "Recognizing scanned pages", done, total }),
      };
      const result = needsOcr
        ? await withModel((engine) => pdfToBook(document.bytes, { ...options, ocr: engine }))
        : await pdfToBook(document.bytes, options);

      send({ type: "stage", stage: "Packing the EPUB" });
      document.book = result.book;
      document.assets = result.assets;
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
    }),
  );

  // The book, for review in the browser — unlike /book.json this is not a
  // download, it is the Review card's data.
  app.get("/api/documents/:id/book", { schema: { params: DocumentParams } }, async (request) => {
    const document = getDocument(request.params.id);
    if (!document.book) throw notFound("nothing converted yet");
    return { book: document.book };
  });

  /**
   * Replace the book with an edited one. The same validation the CLI's `pack`
   * refuses on runs here, so a bad edit is a 400 naming the block — never a
   * corrupt EPUB. On success the EPUB is re-packed immediately; the download
   * links always serve what the review shows.
   */
  app.put("/api/documents/:id/book", { schema: { params: DocumentParams, body: BookBody } }, async (request) => {
    const document = getDocument(request.params.id);
    if (!document.book) throw notFound("nothing converted yet");
    const raw: unknown = request.body.book;
    const issues = validateBook(raw);
    if (issues.length > 0)
      throw badRequest(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const book = raw as Book;
    // the packer refuses an image reference with no bytes behind it — an edit
    // that would produce a broken EPUB is a rejected edit, not a 500
    const epub = await writeEpub(book, document.assets ?? new Map()).catch((error: unknown) => {
      throw badRequest(error instanceof Error ? error.message : String(error));
    });
    document.book = book;
    document.epub = epub;
    return {
      stats: {
        blocks: book.content.length,
        footnotes: Object.keys(book.footnotes).length,
        epubBytes: document.epub.byteLength,
      },
    };
  });

  app.get("/api/documents/:id/assets/:file", { schema: { params: AssetParams } }, async (request, reply) => {
    const document = getDocument(request.params.id);
    const file = `assets/${request.params.file}`;
    const bytes = document.assets?.get(file);
    if (!bytes) throw notFound(`no such asset: ${file}`);
    const type = /\.png$/i.test(file) ? "image/png" : /\.jpe?g$/i.test(file) ? "image/jpeg" : "application/octet-stream";
    return reply.type(type).send(Buffer.from(bytes));
  });

  app.get("/api/documents/:id/epub", { schema: { params: DocumentParams } }, async (request, reply) => {
    const document = getDocument(request.params.id);
    if (!document.epub) throw notFound("nothing converted yet");
    return reply
      .type("application/epub+zip")
      .header("content-disposition", `attachment; filename="${downloadName(document, "epub")}"`)
      .send(document.epub);
  });

  app.get("/api/documents/:id/book.json", { schema: { params: DocumentParams } }, async (request, reply) => {
    const document = getDocument(request.params.id);
    if (!document.book) throw notFound("nothing converted yet");
    return reply
      .type("application/json")
      .header("content-disposition", `attachment; filename="${downloadName(document, "book.json")}"`)
      .send(JSON.stringify(document.book, null, 2) + "\n");
  });
};
