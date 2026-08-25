import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  listModels,
  managedModelDir,
  registerProvider,
  removeModel,
  unloadModel,
  withModel,
  type ModelProvider,
} from "./registry.js";

const idle = (ms: number) => (process.env.BOOKFORGE_MODEL_IDLE_MS = String(ms));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider whose engine only records its own lifecycle — no Python, no weights. */
let counter = 0;
function fakeProvider(create?: () => Promise<never>) {
  const id = `fake-model-${++counter}`;
  const log: string[] = [];
  const provider: ModelProvider = {
    info: {
      id,
      name: id,
      version: "0",
      description: "",
      capabilities: [],
      runtime: "python",
      installLabel: "Install",
      firstRunNote: "",
    },
    async status() {
      return { installed: true, source: null, diskBytes: 0 };
    },
    async create() {
      log.push("create");
      if (create) return await create();
      return {
        name: id,
        async recognize() {
          return [];
        },
        async close() {
          log.push("close");
        },
      };
    },
    async install() {
      return "installed";
    },
    async remove() {
      return "removed";
    },
  };
  registerProvider(provider);
  return { id, log };
}

afterEach(() => {
  delete process.env.BOOKFORGE_MODEL_IDLE_MS;
});

describe("warm model cache", () => {
  test("loads once and keeps the engine warm across requests", async () => {
    idle(10_000);
    const { id, log } = fakeProvider();
    await withModel(id, async () => "a");
    await withModel(id, async () => "b");
    expect(log).toEqual(["create"]);
    expect((await listModels()).find((m) => m.id === id)?.loaded).toBe(true);
  });

  test("unloads after the idle window and reloads on the next request", async () => {
    idle(20);
    const { id, log } = fakeProvider();
    await withModel(id, async () => "a");
    expect(log).toEqual(["create"]);
    await wait(80);
    expect(log).toEqual(["create", "close"]);
    expect((await listModels()).find((m) => m.id === id)?.loaded).toBe(false);
    await withModel(id, async () => "b");
    expect(log).toEqual(["create", "close", "create"]);
  });

  test("an idle window of zero disables keep-alive", async () => {
    idle(0);
    const { id, log } = fakeProvider();
    await withModel(id, async () => "a");
    expect(log).toEqual(["create", "close"]);
  });

  test("evicts a failed engine instead of poisoning later requests", async () => {
    idle(10_000);
    const { id, log } = fakeProvider();
    await expect(withModel(id, async () => Promise.reject(new Error("helper crashed")))).rejects.toThrow("helper crashed");
    expect(log).toEqual(["create", "close"]);
    await withModel(id, async () => "ok");
    expect(log).toEqual(["create", "close", "create"]);
  });

  test("does not cache an engine that failed to start", async () => {
    idle(10_000);
    const { id, log } = fakeProvider(async () => {
      throw new Error("not installed");
    });
    await expect(withModel(id, async () => "a")).rejects.toThrow("not installed");
    await expect(withModel(id, async () => "a")).rejects.toThrow("not installed");
    expect(log).toEqual(["create", "create"]);
  });

  test("unloadModel never closes an engine that is still serving a request", async () => {
    idle(10_000);
    const { id, log } = fakeProvider();
    let finish = () => {};
    const inFlight = withModel(id, async () => await new Promise<void>((resolve) => (finish = resolve)));
    expect(await unloadModel(id)).toEqual({ message: `${id} unloaded from memory.` });
    expect(log).toEqual(["create"]);
    finish();
    await inFlight;
    expect(log).toEqual(["create", "close"]);
    expect((await unloadModel(id)).message).toBe(`${id} is not loaded.`);
  });

  test("rejects unknown model ids", async () => {
    await expect(withModel("nope", async () => "a")).rejects.toThrow("unknown OCR model: nope");
  });
});

describe("managed model directory", () => {
  test("resolves ids inside .bookforge-models and refuses anything else", () => {
    expect(managedModelDir("paddleocr-vl-1.6")).toBe(join(process.cwd(), ".bookforge-models", "paddleocr-vl-1.6"));
    for (const id of ["..", "../evil", ".", "", "a/../..", "/etc"])
      expect(() => managedModelDir(id)).toThrow("refusing to manage");
  });

  test("removing PaddleOCR-VL deletes only the managed runtime, never a user-provided python", async () => {
    const cwd = process.cwd();
    const previous = process.env.BOOKFORGE_PADDLEOCR_PYTHON;
    const root = await mkdtemp(join(tmpdir(), "bookforge-registry-"));
    const external = join(root, ".venv-paddleocr", "bin", "python3");
    await mkdir(dirname(external), { recursive: true });
    await writeFile(external, "#!/bin/sh\n", { mode: 0o755 });
    const managed = join(root, ".bookforge-models", "paddleocr-vl-1.6");
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, "wheel.bin"), Buffer.alloc(4096));

    try {
      process.chdir(root);
      process.env.BOOKFORGE_PADDLEOCR_PYTHON = external;
      const before = (await listModels()).find((model) => model.id === "paddleocr-vl-1.6")!;
      expect(before).toMatchObject({ installed: true, source: "external" });
      expect(before.diskBytes).toBeGreaterThanOrEqual(4096);

      await removeModel("paddleocr-vl-1.6");
      expect(existsSync(managed)).toBe(false);
      expect(existsSync(external)).toBe(true);
      expect((await removeModel("paddleocr-vl-1.6")).message).toBe("No managed PaddleOCR-VL runtime on disk.");
    } finally {
      process.chdir(cwd);
      if (previous === undefined) delete process.env.BOOKFORGE_PADDLEOCR_PYTHON;
      else process.env.BOOKFORGE_PADDLEOCR_PYTHON = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
