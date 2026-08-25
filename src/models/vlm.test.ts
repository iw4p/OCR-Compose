import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ocrBlocksToBookBlocks, ocrFigures } from "../pdf/ocr.js";
import { vlmBlocks, vlmConfig, vlmEndpoint, vlmEngine, vlmLabel, vlmProvider } from "./vlm.js";

/** Caching off unless a test asks for it: no test writes into the repo cache. */
const engine = (cacheDir: string | null = null) => vlmEngine(vlmConfig(), cacheDir);

/** A 24-byte PNG head: only the IHDR size is ever read from the page image. */
const png = (w = 800, h = 1000) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Reply = { status?: number; json?: unknown; text?: string };

/** Stubs the whole HTTP layer: no test ever opens a socket. */
const stub = (respond: (call: Call, nth: number) => Reply) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(call);
    const reply = respond(call, calls.length);
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.json ?? {},
      text: async () => reply.text ?? JSON.stringify(reply.json ?? {}),
    } as unknown as Response;
  });
  return calls;
};

const chat = (content: string): Reply => ({ json: { choices: [{ message: { content } }] } });

const env = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};

afterEach(() => {
  vi.unstubAllGlobals();
  env({ BOOKFORGE_VLM_URL: undefined, BOOKFORGE_VLM_MODEL: undefined, BOOKFORGE_VLM_API_KEY: undefined });
});

const clean = JSON.stringify({
  blocks: [
    { label: "doc_title", text: "CHAPTER II", bbox: [0.3, 0.05, 0.7, 0.1] },
    { label: "paragraph", text: "Alice was beginning to get tired.", bbox: [0.1, 0.2, 0.9, 0.3] },
    { label: "figure", text: "", bbox: [0.1, 0.4, 0.9, 0.7] },
  ],
});

describe("request", () => {
  test("posts the page as a base64 data URI with the configured model and key", async () => {
    env({ BOOKFORGE_VLM_URL: "https://api.example.com/v1/", BOOKFORGE_VLM_MODEL: "vision-x", BOOKFORGE_VLM_API_KEY: "sk-1" });
    const calls = stub(() => chat(clean));
    await engine().recognize(png(), ["en", "fr"]);

    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-1");
    expect(calls[0]!.body.model).toBe("vision-x");
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    const parts = (calls[0]!.body.messages as { content: { type: string; text?: string; image_url?: { url: string } }[] }[])[1]!
      .content;
    expect(parts[0]!.text).toContain("en, fr");
    expect(parts[1]!.image_url!.url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  test("retries without response_format when the server rejects the field", async () => {
    const calls = stub((_call, nth) => (nth === 1 ? { status: 400, text: "unknown field response_format" } : chat(clean)));
    const blocks = await engine().recognize(png(), []);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.response_format).toBeUndefined();
    expect(blocks).toHaveLength(3);
  });

  test("surfaces an HTTP failure with its status and body", async () => {
    stub(() => ({ status: 503, text: "model is loading" }));
    await expect(engine().recognize(png(), [])).rejects.toThrow(/HTTP 503.*model is loading/);
  });

  test("names the endpoint when nothing is listening", async () => {
    env({ BOOKFORGE_VLM_URL: "http://localhost:65500/v1" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(engine().recognize(png(), [])).rejects.toThrow(
      /cannot reach http:\/\/localhost:65500\/v1.*BOOKFORGE_VLM_URL/s
    );
  });

  test("reads a parts-array reply as well as a flat string", async () => {
    stub(() => ({ json: { choices: [{ message: { content: [{ type: "text", text: clean }] } }] } }));
    expect(await engine().recognize(png(), [])).toHaveLength(3);
  });
});

describe("reply parsing", () => {
  const first = (reply: string) => vlmBlocks(reply, null)[0]!;

  test("reads the documented shape and normalizes labels", () => {
    expect(vlmBlocks(clean, null)).toEqual([
      { label: "doc_title", text: "CHAPTER II", x: 0.3, y: 0.05, w: expect.closeTo(0.4, 10), h: expect.closeTo(0.05, 10) },
      { label: "text", text: "Alice was beginning to get tired.", x: 0.1, y: 0.2, w: 0.8, h: expect.closeTo(0.1, 10) },
      { label: "image", text: "", x: 0.1, y: 0.4, w: 0.8, h: expect.closeTo(0.3, 10) },
    ]);
  });

  test("accepts a bare array, a fenced block, and prose around the JSON", () => {
    const array = '[{"label":"text","text":"one","bbox":[0,0,1,0.1]}]';
    for (const reply of [array, "```json\n" + array + "\n```", "Sure! Here is the layout:\n" + array + "\nHope that helps."])
      expect(first(reply)).toMatchObject({ text: "one", label: "text" });
  });

  test("prefers the named block array over any other array in the object", () => {
    const reply = JSON.stringify({ languages: ["en"], blocks: [{ label: "text", text: "one", bbox: [0, 0, 1, 0.1] }] });
    expect(vlmBlocks(reply, null).map((block) => block.text)).toEqual(["one"]);
  });

  test("accepts one JSON object per line", () => {
    const reply = '{"label":"text","text":"one","bbox":[0,0,1,0.1]}\n{"label":"text","text":"two","bbox":[0,0.2,1,0.3]}';
    expect(vlmBlocks(reply, null).map((block) => block.text)).toEqual(["one", "two"]);
  });

  test("keeps a bare list of strings as text in reading order", () => {
    expect(vlmBlocks('["first line","second line"]', null)).toEqual([
      { label: "text", text: "first line", x: 0, y: 0, w: 0, h: 0 },
      { label: "text", text: "second line", x: 0, y: 0, w: 0, h: 0 },
    ]);
  });

  test("an empty page is empty, not an error", () => {
    expect(vlmBlocks('{"blocks": []}', null)).toEqual([]);
  });

  test("explains itself when the model answers with prose or nothing", () => {
    expect(() => vlmBlocks("I'm sorry, I cannot read images.", null, "tiny-model")).toThrow(
      /tiny-model did not return document blocks.*BOOKFORGE_VLM_MODEL.*The reply began: I'm sorry/s
    );
    expect(() => vlmBlocks("   ", null)).toThrow(/The reply was empty/);
    // a JSON error envelope carries no blocks either, and must not read as a blank page
    expect(() => vlmBlocks('{"error":"context length exceeded"}', null)).toThrow(/did not return document blocks/);
  });

  test("skips malformed entries instead of losing the whole page", () => {
    const reply = JSON.stringify({
      blocks: [
        "not an object",
        null,
        42,
        { label: "text", text: "kept", bbox: [0, 0, 1, 0.1] },
        { label: "text", bbox: [0, 0.2, 1, 0.3] },
      ],
    });
    // the textless paragraph carries nothing; only a picture may be text-free
    expect(vlmBlocks(reply, null).map((block) => block.text)).toEqual(["not an object", "kept"]);
  });
});

describe("bounding boxes", () => {
  const box = (entry: unknown, size?: { w: number; h: number }) =>
    vlmBlocks(JSON.stringify({ blocks: [entry] }), size ?? null)[0];

  test("rescales the 0-1000 grid many VLMs are trained on, and percentages", () => {
    const expected = { x: 0.1, y: 0.2, w: expect.closeTo(0.8, 10), h: expect.closeTo(0.1, 10) };
    expect(box({ label: "text", text: "a", bbox: [100, 200, 900, 300] })).toMatchObject(expected);
    expect(box({ label: "text", text: "a", bbox: [10, 20, 90, 30] })).toMatchObject(expected);
  });

  test("rescales page pixels using the PNG header, preferring the tightest fit", () => {
    expect(box({ label: "text", text: "a", bbox: [80, 100, 720, 200] }, { w: 800, h: 1000 })).toMatchObject({
      x: 0.1,
      y: 0.1,
      w: expect.closeTo(0.8, 10),
      h: expect.closeTo(0.1, 10),
    });
    // beyond the page in pixels, so the 0-1000 grid is the only reading that fits
    expect(box({ label: "text", text: "a", bbox: [100, 200, 900, 300] }, { w: 600, h: 800 })).toMatchObject({ x: 0.1 });
  });

  test("accepts x/y/w/h, corner pairs and nested point arrays", () => {
    const expected = { x: 0.1, y: 0.2, w: expect.closeTo(0.8, 10), h: expect.closeTo(0.1, 10) };
    expect(box({ label: "text", text: "a", bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } })).toMatchObject(expected);
    expect(box({ label: "text", text: "a", x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.3 })).toMatchObject(expected);
    expect(box({ label: "text", text: "a", bbox_2d: [[0.1, 0.2], [0.9, 0.3]] })).toMatchObject(expected);
    expect(box({ label: "text", text: "a", bbox: ["0.1", "0.2", "0.9", "0.3"] })).toMatchObject(expected);
  });

  test("clamps a box that overhangs the page", () => {
    expect(box({ label: "text", text: "a", bbox: [-0.2, -0.1, 1.01, 0.4] })).toMatchObject({ x: 0, y: 0, w: 1 });
  });

  test("an unusable box keeps its text inert and never becomes a figure region", () => {
    for (const bad of [undefined, [0.1], [0.5, 0.5, 0.4, 0.4], ["a", "b", "c", "d"], { x: 0.1, y: 0.2 }]) {
      const entry = { label: "text", text: "still here", ...(bad === undefined ? {} : { bbox: bad }) };
      expect(box(entry)).toEqual({ label: "text", text: "still here", x: 0, y: 0, w: 0, h: 0 });
    }
    // a picture nobody can locate is dropped rather than cropped from nothing
    expect(vlmBlocks('{"blocks":[{"label":"figure","text":""}]}', null)).toEqual([]);
    expect(ocrFigures(vlmBlocks('{"blocks":[{"label":"figure","text":"","bbox":[0.1,0.4,0.9,0.7]}]}', null))).toHaveLength(1);
  });
});

describe("label normalization", () => {
  test("maps model vocabularies onto the labels the shared mapper understands", () => {
    const cases: Record<string, string[]> = {
      doc_title: ["Title", "doc-title", "chapter_title", "h1"],
      paragraph_title: ["heading", "section header", "H3", "subtitle"],
      text: ["paragraph", "plain text", "body", "abstract", "", "something new"],
      caption: ["figure_caption", "table caption", "Caption"],
      table: ["table", "Table"],
      formula: ["formula", "equation", "isolate_formula"],
      list: ["list", "bulleted_list"],
      image: ["image", "figure", "photograph", "chart", "diagram", "seal"],
      header: ["page header", "running head"],
      footer: ["page footer"],
      number: ["page_number", "PageNumber"],
      footnote: ["footnote"],
    };
    for (const [normalized, raw] of Object.entries(cases))
      for (const label of raw) expect([label, vlmLabel(label)]).toEqual([label, normalized]);
  });

  test("normalized blocks flow straight into contract blocks", () => {
    const reply = JSON.stringify({
      blocks: [
        { label: "Title", text: "CHAPTER II", bbox: [300, 50, 700, 100] },
        { label: "Section Header", text: "Down the Rabbit-Hole", bbox: [100, 120, 900, 160] },
        { label: "paragraph", text: "Alice was beginning to get tired.", bbox: [100, 200, 900, 300] },
        { label: "table", text: "<table><tr><td>a</td><td>b</td></tr></table>", bbox: [100, 320, 900, 400] },
        { label: "equation", text: "E = mc^2", bbox: [100, 420, 900, 460] },
        { label: "bulleted_list", text: "- one\n- two", bbox: [100, 480, 900, 540] },
        { label: "figure", text: "", bbox: [100, 560, 900, 800] },
        { label: "figure_caption", text: "The White Rabbit.", bbox: [100, 810, 900, 840] },
      ],
    });
    expect(ocrBlocksToBookBlocks(vlmBlocks(reply, null), 12)).toEqual([
      { type: "heading", level: 1, text: "CHAPTER II", page: 12 },
      { type: "heading", level: 2, text: "Down the Rabbit-Hole", page: 12 },
      { type: "text", text: "Alice was beginning to get tired.", page: 12 },
      { type: "table", rows: [["a", "b"]], page: 12 },
      { type: "formula", display: true, tex: "E = mc^2", page: 12 },
      { type: "list", ordered: false, items: [[{ type: "text", text: "one", page: 12 }], [{ type: "text", text: "two", page: 12 }]], page: 12 },
      { type: "image", file: expect.stringMatching(/^assets\/fig-12-[0-9a-f]{12}\.png$/), caption: "The White Rabbit.", page: 12 },
    ]);
  });
});

describe("provider", () => {
  test("a default endpoint is local and holds nothing on disk", async () => {
    env({ BOOKFORGE_VLM_URL: "http://localhost:11434/v1" });
    stub(() => ({}));
    expect(vlmEndpoint()).toEqual({ url: "http://localhost:11434/v1", local: true });
    expect(await vlmProvider.status()).toEqual({
      installed: true,
      source: "external",
      diskBytes: 0,
      endpoint: { url: "http://localhost:11434/v1", local: true },
    });
  });

  test("a hosted endpoint is flagged as leaving the machine", async () => {
    env({ BOOKFORGE_VLM_URL: "https://openrouter.ai/api/v1", BOOKFORGE_VLM_MODEL: "some/vlm" });
    stub(() => ({}));
    expect(await vlmProvider.status()).toMatchObject({ endpoint: { local: false }, diskBytes: 0 });
    expect(await vlmProvider.install()).toMatch(/not on your machine: every page image leaves it/);
  });

  test("private and loopback hosts count as local, public ones do not", () => {
    for (const url of ["http://127.0.0.1:1234/v1", "http://[::1]:1/v1", "http://192.168.1.9:11434/v1", "http://mac.local/v1"]) {
      env({ BOOKFORGE_VLM_URL: url });
      expect(vlmEndpoint().local).toBe(true);
    }
    for (const url of ["https://api.openai.com/v1", "http://8.8.8.8/v1", "not a url"]) {
      env({ BOOKFORGE_VLM_URL: url });
      expect(vlmEndpoint().local).toBe(false);
    }
  });

  test("an unreachable endpoint is not installed, and checking it says why", async () => {
    env({ BOOKFORGE_VLM_URL: "http://localhost:65501/v1" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await vlmProvider.status()).toMatchObject({ installed: false, source: null });
    await expect(vlmProvider.install()).rejects.toThrow(/No OpenAI-compatible server answered.*ollama serve/s);
  });

  test("remove() deletes nothing and says so", async () => {
    expect(await vlmProvider.remove()).toMatch(/Nothing to remove/);
  });
});

describe("cache", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bookforge-vlm-cache-"));
    env({ BOOKFORGE_VLM_URL: "https://api.example.com/v1", BOOKFORGE_VLM_MODEL: "vision-x" });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a page already recognized is served from disk, with no second request", async () => {
    const calls = stub(() => chat(clean));
    const first = await engine(dir).recognize(png(), ["en"]);
    // a second engine: the entry outlives the object that wrote it (P6)
    const second = await engine(dir).recognize(png(), ["en"]);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(await readdir(dir)).toHaveLength(1);
  });

  test("another model, another endpoint or another page is a different entry", async () => {
    const calls = stub(() => chat(clean));
    await engine(dir).recognize(png(), ["en"]);
    env({ BOOKFORGE_VLM_MODEL: "vision-y" });
    await engine(dir).recognize(png(), ["en"]);
    // the same model name on a second server is a different model
    env({ BOOKFORGE_VLM_MODEL: "vision-x", BOOKFORGE_VLM_URL: "https://other.example.com/v1" });
    await engine(dir).recognize(png(), ["en"]);
    // and neither the page nor the languages may be dropped from the key
    env({ BOOKFORGE_VLM_URL: "https://api.example.com/v1" });
    await engine(dir).recognize(png(600, 800), ["en"]);
    await engine(dir).recognize(png(), ["de"]);
    expect(calls).toHaveLength(5);
    expect(await readdir(dir)).toHaveLength(5);

    // the key is authorization, not identity: it must not split the cache
    env({ BOOKFORGE_VLM_API_KEY: "sk-1" });
    await engine(dir).recognize(png(), ["en"]);
    expect(calls).toHaveLength(5);
  });

  test("a corrupt entry is a miss, not a crash, and is written over", async () => {
    const calls = stub(() => chat(clean));
    const blocks = await engine(dir).recognize(png(), ["en"]);
    const [file] = await readdir(dir);
    await writeFile(join(dir, file!), "{ truncated mid-w");
    expect(await engine(dir).recognize(png(), ["en"])).toEqual(blocks);
    expect(calls).toHaveLength(2);
    expect(await engine(dir).recognize(png(), ["en"])).toEqual(blocks);
    expect(calls).toHaveLength(2);
  });

  test("an unwritable cache directory slows a run down, it does not fail it", async () => {
    const calls = stub(() => chat(clean));
    // a file where the directory should be: nothing under it can be created
    await writeFile(join(dir, "wall"), "");
    const blocks = await engine(join(dir, "wall", "pages")).recognize(png(), ["en"]);
    expect(blocks).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});
