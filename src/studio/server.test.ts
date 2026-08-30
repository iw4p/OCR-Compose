import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startStudio } from "./server.js";

let server: Server;
let base = "";
let pdf: Uint8Array;

beforeAll(async () => {
  pdf = new Uint8Array(await readFile("corpus/pdf/frankenstein.pdf"));
  const studio = await startStudio({ port: 0 });
  server = studio.server;
  base = studio.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const upload = async (name = "frankenstein.pdf") => {
  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: { "x-ocr-compose-filename": encodeURIComponent(name) },
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

  test("a document id that is not a uuid never reaches a handler", async () => {
    expect((await fetch(`${base}/api/documents/..%2F..%2Fetc/epub`)).status).toBe(404);
  });

  test("reports the model and the hardware the estimates are based on", async () => {
    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      model: { id: string; installed: boolean };
      hardware: { cores: number; memoryBytes: number };
    };
    expect(status.model.id).toBe("paddleocr-vl-1.6");
    expect(status.hardware.cores).toBeGreaterThan(0);
    expect(status.hardware.memoryBytes).toBeGreaterThan(0);
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
    const response = await fetch(`${base}/api/documents`, { method: "POST", body: new Uint8Array() });
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

  test("only the most recent documents are kept in memory", async () => {
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

  test("an EPUB is only offered once there is one", async () => {
    const { id } = await upload();
    expect((await fetch(`${base}/api/documents/${id}/book.json`)).status).toBe(404);
  });
});
