import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MODEL_ID, managedModelDir, modelStatus, removeModel, unloadModel, withModel } from "./registry.js";

const idle = (ms: number) => (process.env.OCR_COMPOSE_MODEL_IDLE_MS = String(ms));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const loaded = async () => (await modelStatus()).loaded;

// A stub interpreter is enough: the engine only spawns Python when a page is
// actually recognized, so the whole keep-alive lifecycle runs with no model.
let root = "";
const cwd = process.cwd();
const previousPython = process.env.OCR_COMPOSE_PADDLEOCR_PYTHON;

const fakePython = async () => {
  const path = join(root, "stub", "python3");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OCR_COMPOSE_PADDLEOCR_PYTHON = path;
  return path;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocr-compose-registry-"));
  process.chdir(root);
});

afterEach(async () => {
  await unloadModel();
  process.chdir(cwd);
  delete process.env.OCR_COMPOSE_MODEL_IDLE_MS;
  if (previousPython === undefined) delete process.env.OCR_COMPOSE_PADDLEOCR_PYTHON;
  else process.env.OCR_COMPOSE_PADDLEOCR_PYTHON = previousPython;
  await rm(root, { recursive: true, force: true });
});

describe("warm model cache", () => {
  test("keeps the engine warm across requests", async () => {
    idle(10_000);
    await fakePython();
    expect(await withModel(async () => "a")).toBe("a");
    expect(await withModel(async () => "b")).toBe("b");
    expect(await loaded()).toBe(true);
  });

  test("unloads after the idle window", async () => {
    idle(20);
    await fakePython();
    await withModel(async () => "a");
    await wait(80);
    expect(await loaded()).toBe(false);
  });

  test("an idle window of zero disables keep-alive", async () => {
    idle(0);
    await fakePython();
    await withModel(async () => "a");
    expect(await loaded()).toBe(false);
  });

  test("evicts a failed engine instead of poisoning later requests", async () => {
    idle(10_000);
    await fakePython();
    await expect(withModel(() => Promise.reject(new Error("helper crashed")))).rejects.toThrow("helper crashed");
    expect(await loaded()).toBe(false);
    await withModel(async () => "ok");
    expect(await loaded()).toBe(true);
  });

  test("refuses to run when nothing is installed", async () => {
    delete process.env.OCR_COMPOSE_PADDLEOCR_PYTHON;
    await expect(withModel(async () => "a")).rejects.toThrow("not installed");
    expect(await loaded()).toBe(false);
  });

  test("unloadModel never closes an engine that is still serving a request", async () => {
    idle(10_000);
    await fakePython();
    let finish = () => {};
    let running = () => {};
    const started = new Promise<void>((resolve) => (running = resolve));
    const inFlight = withModel(async () => {
      running();
      await new Promise<void>((resolve) => (finish = resolve));
    });
    await started; // the engine is only "in use" once `use` is actually called
    expect(await unloadModel()).toBe("PaddleOCR-VL unloaded from memory.");
    finish();
    await inFlight;
    expect(await unloadModel()).toBe("PaddleOCR-VL is not loaded.");
  });
});

describe("managed model directory", () => {
  test("resolves ids inside .ocr-compose-models and refuses anything else", () => {
    expect(managedModelDir(MODEL_ID)).toBe(join(process.cwd(), ".ocr-compose-models", MODEL_ID));
    for (const id of ["..", "../evil", ".", "", "a/../..", "/etc"])
      expect(() => managedModelDir(id)).toThrow("refusing to manage");
  });

  test("removing deletes only the managed runtime, never a user-provided python", async () => {
    const external = join(root, ".venv-paddleocr", "bin", "python3");
    await mkdir(dirname(external), { recursive: true });
    await writeFile(external, "#!/bin/sh\n", { mode: 0o755 });
    process.env.OCR_COMPOSE_PADDLEOCR_PYTHON = external;
    const managed = join(root, ".ocr-compose-models", MODEL_ID);
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, "wheel.bin"), Buffer.alloc(4096));

    const before = await modelStatus();
    expect(before).toMatchObject({ installed: true, source: "external" });
    expect(before.diskBytes).toBeGreaterThanOrEqual(4096);

    await removeModel();
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(external)).toBe(true);
    expect(await removeModel()).toBe("No managed PaddleOCR-VL runtime on disk.");
  });
});
