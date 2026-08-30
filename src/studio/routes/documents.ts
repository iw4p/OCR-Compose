import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { writeEpub } from "../../epub/write.js";
import { withModel } from "../../models/registry.js";
import { renderPagePng } from "../../pdf/extract.js";
import { ocrBlocksToBookBlocks } from "../../pdf/ocr.js";
import { OCR_SCALE, pdfToBook } from "../../pdf/pdf.js";
import { addDocument, downloadName, getDocument, requirePage } from "../documents.js";
import { notFound } from "../errors.js";
import { ConvertBody, DocumentParams, PageParams, PageQuery, TestBody, parse } from "../schemas.js";
import { stream } from "../stream.js";

/** 512 MB: the whole PDF is read into memory, and books get big. */
const UPLOAD_LIMIT = 512 * 1024 * 1024;

export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post("/api/documents", { bodyLimit: UPLOAD_LIMIT }, async (request) => {
    const name = decodeURIComponent(String(request.headers["x-ocr-compose-filename"] ?? "book.pdf")).replace(
      /[/\\]/g,
      "-",
    );
    return addDocument(name, new Uint8Array(request.body as Buffer)).summary;
  });

  app.get("/api/documents/:id/pages/:page.png", { schema: { params: PageParams, querystring: PageQuery } }, async (request, reply) => {
    const document = getDocument(request.params.id);
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
    const document = getDocument(request.params.id);
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
      const document = getDocument(parse(DocumentParams, request.params).id);
      const body = parse(ConvertBody, request.body);
      const pages = [...new Set(body.pages)].sort((a, b) => a - b);
      const needsOcr = document.reports.some((report) => pages.includes(report.page) && report.verdict === "scanned");

      send({ type: "stage", stage: needsOcr ? "Loading the model" : "Reading pages" });
      const options = {
        pages,
        ...(body.title && { title: body.title }),
        ...(body.author && { author: body.author }),
        language: body.language,
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
    }),
  );

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
