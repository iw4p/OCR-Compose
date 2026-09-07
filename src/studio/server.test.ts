import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startStudio } from "./server.js";

let close: () => Promise<void>;
let base = "";
let pdf: Uint8Array;

beforeAll(async () => {
  pdf = new Uint8Array(await readFile("corpus/pdf/frankenstein.pdf"));
  const studio = await startStudio({ port: 0 });
  close = () => studio.app.close();
  base = studio.url;
});

afterAll(async () => {
  await close();
});

const upload = async (name = "frankenstein.pdf") => {
  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: { "x-ocr-compose-filename": encodeURIComponent(name), "content-type": "application/pdf" },
    body: pdf,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    name: string;
    pageCount: number;
    counts: Record<string, number>;
    suggestedPage: number;
    title: string;
  };
};

/** Collects a job stream into the list of events it delivered. */
const events = async (response: Response): Promise<Record<string, unknown>[]> => {
  expect(response.ok).toBe(true);
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((part) => part.startsWith("data: "))
    .map((part) => JSON.parse(part.slice(6)) as Record<string, unknown>);
};

const convert = (id: string, body: unknown) =>
  fetch(`${base}/api/documents/${id}/convert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("routing", () => {
  test("an unknown path is a 404 that names what was asked for", async () => {
    const response = await fetch(`${base}/api/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("/api/nope");
  });

  test("a known path with the wrong method does not match", async () => {
    expect((await fetch(`${base}/api/documents`)).status).toBe(404);
    expect((await fetch(`${base}/api/status`, { method: "POST" })).status).toBe(404);
  });

  test("a document id that is not a uuid is rejected before any handler runs", async () => {
    const response = await fetch(`${base}/api/documents/..%2F..%2Fetc/epub`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/id/i);
  });

  test("reports the model and the hardware the estimates are based on", async () => {
    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      model: { id: string; installed: boolean; fast: Record<string, unknown> };
      hardware: { cores: number; memoryBytes: number };
    };
    expect(status.model.id).toBe("paddleocr-vl-1.6");
    expect(status.hardware.cores).toBeGreaterThan(0);
    expect(status.hardware.memoryBytes).toBeGreaterThan(0);
    // fast mode is part of the status contract on every platform
    expect(Object.keys(status.model.fast).sort()).toEqual(["downloadBytes", "enabled", "installed", "running", "supported"]);
  });
});

describe("documents", () => {
  test("classifies every page of an uploaded PDF", async () => {
    const document = await upload();
    expect(document.pageCount).toBeGreaterThan(100);
    expect(document.counts.native).toBe(document.pageCount);
    expect(document.suggestedPage).toBeGreaterThanOrEqual(1);
    expect(document.title).not.toBe("");
  });

  test("an empty upload is refused", async () => {
    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array(),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("empty");
  });

  test("renders a page as a PNG, and refuses one outside the document", async () => {
    const { id } = await upload();
    const image = await fetch(`${base}/api/documents/${id}/pages/2.png?scale=0.4`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const missing = await fetch(`${base}/api/documents/${id}/pages/99999.png`);
    expect(missing.status).toBe(400);
  });

  test("a forgotten document is a 404, not a crash", async () => {
    const response = await fetch(`${base}/api/documents/${crypto.randomUUID()}/epub`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("no longer loaded");
  });

  // Four full uploads of a 200-page PDF, each classified page by page — the
  // one test that legitimately outgrows the default timeout on a slow CI box.
  test("only the most recent documents are kept in memory", { timeout: 30_000 }, async () => {
    const first = await upload("first.pdf");
    for (let i = 0; i < 3; i++) await upload(`later-${i}.pdf`);
    expect((await fetch(`${base}/api/documents/${first.id}/epub`)).status).toBe(404);
  });
});

// The regression these guard: a streaming endpoint that answered a rejected
// request with a status code left the client — which is reading events, not
// statuses — showing nothing at all.
describe("a job stream reports its own failures", () => {
  test("an invalid request body arrives as an error event", async () => {
    const { id } = await upload();
    const delivered = await events(await convert(id, { pages: [] }));
    expect(delivered).toEqual([{ type: "error", message: expect.stringContaining("select at least one page") }]);
  });

  test("a wrong-typed field arrives as an error event naming the field", async () => {
    const { id } = await upload();
    const delivered = await events(await convert(id, { pages: "everything" }));
    expect(delivered[0]).toMatchObject({ type: "error" });
    expect(String(delivered[0]!.message)).toContain("pages");
  });

  // Paper mode routes native pages through the model, so asking for it on a
  // machine without the model must fail as an event the client can show.
  // (Skipped where the model actually is installed — it would really convert.
  // The paths mirror the registry's findPython candidates.)
  test.skipIf(
    existsSync(".ocr-compose-models/paddleocr-vl-1.6") ||
      existsSync(".venv-paddleocr") ||
      !!process.env.OCR_COMPOSE_PADDLEOCR_PYTHON,
  )(
    "paper mode without an installed model arrives as an error event",
    async () => {
      const { id } = await upload();
      const delivered = await events(await convert(id, { pages: [1], ocrAll: true }));
      expect(delivered.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("not installed") });
    },
  );

  test("a forgotten document arrives as an error event", async () => {
    const delivered = await events(await convert(crypto.randomUUID(), { pages: [1] }));
    expect(delivered).toEqual([{ type: "error", message: expect.stringContaining("no longer loaded") }]);
  });
});

describe("convert", () => {
  test("streams its stages, then serves the EPUB and the book.json", async () => {
    const { id } = await upload();
    const delivered = await events(await convert(id, { pages: [1, 2, 3], title: "F", author: "M", language: "en" }));

    expect(delivered.map((event) => event.type)).toContain("stage");
    const done = delivered.at(-1) as { type: string; stats: { blocks: number; epubBytes: number } };
    expect(done.type).toBe("done");
    expect(done.stats.blocks).toBeGreaterThan(0);
    expect(done.stats.epubBytes).toBeGreaterThan(0);

    const epub = await fetch(`${base}/api/documents/${id}/epub`);
    expect(epub.headers.get("content-type")).toBe("application/epub+zip");
    expect(epub.headers.get("content-disposition")).toContain("frankenstein.epub");
    expect(new Uint8Array(await epub.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));

    const book = (await (await fetch(`${base}/api/documents/${id}/book.json`)).json()) as {
      title: string;
      content: unknown[];
    };
    expect(book.title).toBe("F");
    expect(book.content.length).toBe(done.stats.blocks);
  });

  test("serves the book for review, and accepts a validated edit", async () => {
    const { id } = await upload();
    expect((await fetch(`${base}/api/documents/${id}/book`)).status).toBe(404);
    await events(await convert(id, { pages: [1, 2, 3], title: "F", language: "en" }));

    const { book } = (await (await fetch(`${base}/api/documents/${id}/book`)).json()) as {
      book: { title: string; content: { type: string; text?: string }[] };
    };
    expect(book.title).toBe("F");
    expect(book.content.length).toBeGreaterThan(0);

    // a real edit lands in the book AND in the re-packed EPUB
    const edited = structuredClone(book);
    edited.content[0] = { type: "text", text: "Edited in the Review card." };
    const put = await fetch(`${base}/api/documents/${id}/book`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: edited }),
    });
    expect(put.status).toBe(200);
    const back = (await (await fetch(`${base}/api/documents/${id}/book`)).json()) as typeof edited & {
      book: { content: { text?: string }[] };
    };
    expect((back as { book: { content: { text?: string }[] } }).book.content[0]!.text).toBe("Edited in the Review card.");
    const epub = await (await fetch(`${base}/api/documents/${id}/epub`)).arrayBuffer();
    expect(epub.byteLength).toBeGreaterThan(0);
  });

  test("an invalid edit is refused naming the problem, and changes nothing", async () => {
    const { id } = await upload();
    await events(await convert(id, { pages: [1], title: "F", language: "en" }));
    const { book } = (await (await fetch(`${base}/api/documents/${id}/book`)).json()) as { book: { content: unknown[] } };
    const broken = structuredClone(book);
    broken.content[0] = { type: "text", text: "unclosed *emphasis" };
    const put = await fetch(`${base}/api/documents/${id}/book`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: broken }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toContain("content.0");
    const after = (await (await fetch(`${base}/api/documents/${id}/book`)).json()) as { book: { content: { text?: string }[] } };
    expect(after.book.content[0]!.text).not.toContain("unclosed");
  });

  test("a converted EPUB can come back later: upload, review, edit, download", async () => {
    const { id } = await upload();
    await events(await convert(id, { pages: [1, 2, 3], title: "F", language: "en" }));
    const epub = new Uint8Array(await (await fetch(`${base}/api/documents/${id}/epub`)).arrayBuffer());

    const back = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "x-ocr-compose-filename": "F.epub", "content-type": "application/epub+zip" },
      body: epub,
    });
    expect(back.status).toBe(200);
    const summary = (await back.json()) as { id: string; kind: string; title: string };
    expect(summary.kind).toBe("book");
    expect(summary.title).toBe("F");

    // straight to review — and the downloads are live without any conversion
    const { book } = (await (await fetch(`${base}/api/documents/${summary.id}/book`)).json()) as {
      book: { content: unknown[] };
    };
    expect(book.content.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/api/documents/${summary.id}/epub`)).status).toBe(200);
  });

  test("a bare book.json uploads, packs, and refuses page routes politely", async () => {
    const plain = {
      title: "Notizen",
      language: "de",
      content: [
        { type: "heading", level: 1, text: "Kapitel 1" },
        { type: "text", text: "Ein Absatz mit *Nachdruck*." },
      ],
      footnotes: {},
    };
    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "x-ocr-compose-filename": "notizen.json", "content-type": "application/json" },
      body: JSON.stringify(plain),
    });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as { id: string; kind: string; title: string };
    expect(summary.kind).toBe("book");
    expect(summary.title).toBe("Notizen");

    const epub = await fetch(`${base}/api/documents/${summary.id}/epub`);
    expect(epub.headers.get("content-type")).toBe("application/epub+zip");
    expect(epub.headers.get("content-disposition")).toContain("notizen.epub");

    const delivered = await events(await convert(summary.id, { pages: [1], language: "en" }));
    expect(delivered).toEqual([{ type: "error", message: expect.stringContaining("a book, not a PDF") }]);
  });

  test("a book.json that references images it cannot carry is refused with the way out", async () => {
    const { feldtheorie } = await import("../fixtures.js");
    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "x-ocr-compose-filename": "feldtheorie.json", "content-type": "application/json" },
      body: JSON.stringify(feldtheorie),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("upload the EPUB instead");
  });

  test("an invalid book.json is refused naming the first problem", async () => {
    const response = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "x-ocr-compose-filename": "broken.json", "content-type": "application/json" },
      body: JSON.stringify({ title: "No content", language: "en" }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("not a valid book.json");
  });

  test("an unknown asset is a 404, and asset names cannot carry paths", async () => {
    const { id } = await upload();
    expect((await fetch(`${base}/api/documents/${id}/assets/nope.png`)).status).toBe(404);
    expect((await fetch(`${base}/api/documents/${id}/assets/..%2Fsecret.png`)).status).toBe(400);
  });

  test("an EPUB is only offered once there is one", async () => {
    const { id } = await upload();
    expect((await fetch(`${base}/api/documents/${id}/book.json`)).status).toBe(404);
  });
});
