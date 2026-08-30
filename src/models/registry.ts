// The one OCR model OCR Compose installs and runs: PaddleOCR-VL, in an isolated
// Python venv under `.ocr-compose-models/`. Installation is a subprocess whose
// output is streamed to the caller, so the UI can show real download progress.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { paddleEngine, type OcrEngine } from "../pdf/ocr.js";

export const MODEL_ID = "paddleocr-vl-1.6";

export type ModelStatus = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** True once a usable Python environment exists — ours or the operator's. */
  installed: boolean;
  /** `managed` = we installed it and may delete it. `external` = the operator's. */
  source: "managed" | "external" | null;
  /** Bytes under `.ocr-compose-models/<id>/`; 0 for an external runtime. */
  diskBytes: number;
  /** Bytes of model weights actually downloaded into the shared PaddleX cache. */
  weightsDiskBytes: number;
  /** What a fresh install costs to download, before anything is on disk. */
  runtimeDownloadBytes: number;
  weightsDownloadBytes: number;
  /** True while a warm engine is held in memory. */
  loaded: boolean;
};

/**
 * The only directory tree OCR Compose ever deletes. Resolved and re-checked on
 * every use so no symlink or env var can escape it — a user-provided
 * interpreter (`OCR_COMPOSE_PADDLEOCR_PYTHON`, `.venv-paddleocr/`) is never ours.
 */
export const managedModelDir = (id: string) => {
  const root = resolve(process.cwd(), ".ocr-compose-models");
  const dir = resolve(root, id);
  if (dir === root || !dir.startsWith(root + sep)) throw new Error(`refusing to manage ${dir}`);
  return dir;
};
const venvDir = () => join(managedModelDir(MODEL_ID), "venv");
const venvPython = () =>
  process.platform === "win32" ? join(venvDir(), "Scripts", "python.exe") : join(venvDir(), "bin", "python");

/** Recursive apparent size. Symlinks are counted as neither file nor directory. */
const dirBytes = async (dir: string): Promise<number> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(path);
    else if (entry.isFile()) total += await stat(path).then((s) => s.size, () => 0);
  }
  return total;
};

const executable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first usable interpreter: the operator's, then ours. `null` if none is. */
const findPython = async (): Promise<string | null> => {
  const candidates = [
    process.env.OCR_COMPOSE_PADDLEOCR_PYTHON,
    venvPython(),
    join(process.cwd(), ".venv-paddleocr", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3"),
  ];
  for (const candidate of candidates) if (candidate && (await executable(candidate))) return candidate;
  return null;
};

const run = async (command: string, args: string[], onLog?: (line: string) => void): Promise<string> =>
  await new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let partial = "";
    const read = (chunk: string) => {
      output = (output + chunk).slice(-32_768);
      if (!onLog) return;
      partial += chunk;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLog(line.trim());
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", fail);
    child.once("close", (code) => {
      if (partial.trim()) onLog?.(partial.trim());
      if (code === 0) done(output);
      else fail(new Error(`${command} exited with code ${code ?? "unknown"}\n${output}`));
    });
  });

export async function modelStatus(): Promise<ModelStatus> {
  const python = await findPython();
  const managed = managedModelDir(MODEL_ID);
  return {
    id: MODEL_ID,
    name: "PaddleOCR-VL",
    version: "1.6",
    description: "Document layout, multilingual OCR, tables and formulas.",
    installed: python !== null,
    source: python === null ? null : resolve(python).startsWith(managed + sep) ? "managed" : "external",
    diskBytes: await dirBytes(managed),
    weightsDiskBytes: await dirBytes(join(homedir(), ".paddlex", "official_models")),
    runtimeDownloadBytes: 1_200_000_000,
    weightsDownloadBytes: 2_000_000_000,
    loaded: warm !== null,
  };
}

/** Creates an isolated venv and pip-installs PaddleOCR into it. */
export async function installModel(onLog: (line: string) => void = () => {}): Promise<string> {
  if (await findPython()) return "PaddleOCR-VL is already installed.";
  const base = process.env.OCR_COMPOSE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const version = (await run(base, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"])).trim();
  const [major] = version.split(/\s+/).map(Number);
  if (major !== 3) throw new Error(`${base} is not Python 3. Set OCR_COMPOSE_PYTHON to one that is.`);
  onLog(`Creating a Python environment with ${base}…`);
  await mkdir(managedModelDir(MODEL_ID), { recursive: true });
  await run(base, ["-m", "venv", venvDir()]);
  const python = venvPython();
  await run(python, ["-m", "pip", "install", "--upgrade", "pip"], onLog);
  onLog("Downloading PaddlePaddle and PaddleOCR (about 1.2 GB)…");
  await run(python, ["-m", "pip", "install", "paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.6.0"], onLog);
  return "Runtime installed. The model weights (~2 GB) download on the first page you run.";
}

/** Destructive: unloads, then deletes the managed runtime from disk. */
export async function removeModel(): Promise<string> {
  await unloadModel();
  const dir = managedModelDir(MODEL_ID);
  if (!(await stat(dir).catch(() => null))) return "No managed PaddleOCR-VL runtime on disk.";
  await rm(dir, { recursive: true, force: true });
  return "Removed the managed runtime. Downloaded weights stay in the shared PaddleX cache.";
}

// Keep-alive, like `ollama`: the model stays warm between requests and unloads
// itself once idle, so a test page and the conversion that follows pay the
// weight-loading cost once. Engines are refcounted; only the last user closes.
type Warm = { engine: Promise<OcrEngine>; users: number; idle?: ReturnType<typeof setTimeout> };
let warm: Warm | null = null;
const idleMs = () => Number(process.env.OCR_COMPOSE_MODEL_IDLE_MS ?? 300_000);

const shutdown = async (entry: Warm) => {
  await entry.engine.then((engine) => engine.close?.()).catch(() => {});
};

const release = (entry: Warm) => {
  const cached = warm === entry;
  if (!cached || idleMs() <= 0) {
    if (cached) warm = null;
    void shutdown(entry);
    return;
  }
  entry.idle = setTimeout(() => {
    if (warm !== entry) return;
    warm = null;
    void shutdown(entry);
  }, idleMs());
  entry.idle.unref?.();
};

const createEngine = async (): Promise<OcrEngine> => {
  const python = await findPython();
  if (!python) throw new Error("PaddleOCR-VL is not installed. Install it first.");
  return paddleEngine({ pythonPath: python });
};

/**
 * Runs `use` against a warm engine, loading one if needed. A failure evicts the
 * engine so a crashed helper process never poisons the next request.
 */
export async function withModel<T>(use: (engine: OcrEngine) => Promise<T>): Promise<T> {
  let entry = warm;
  if (!entry) warm = entry = { engine: createEngine(), users: 0 };
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = undefined;
  entry.users++;
  try {
    return await use(await entry.engine);
  } catch (error) {
    if (warm === entry) warm = null;
    throw error;
  } finally {
    if (--entry.users === 0) release(entry);
  }
}

/** Frees memory now. An engine still serving a request closes when it finishes. */
export async function unloadModel(): Promise<string> {
  const entry = warm;
  if (!entry) return "PaddleOCR-VL is not loaded.";
  warm = null;
  if (entry.idle) clearTimeout(entry.idle);
  if (entry.users === 0) await shutdown(entry);
  return "PaddleOCR-VL unloaded from memory.";
}
