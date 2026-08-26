import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { onnxtrEngine, paddleEngine, type OcrEngine } from "../pdf/ocr.js";

export type ModelCapability = "layout" | "multilingual" | "tables" | "formulas";

/** Where an installed runtime lives. Only `managed` runtimes may be removed. */
export type ModelSource = "managed" | "external";

export type ModelStatus = {
  installed: boolean;
  source: ModelSource | null;
  /** Approximate bytes under `.bookforge-models/<id>/`; 0 for external runtimes. */
  diskBytes: number;
};

export type ModelInfo = ModelStatus & {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: ModelCapability[];
  installLabel: string;
  firstRunNote: string;
  /** True while a warm engine is held in memory for this model. */
  loaded: boolean;
};

const PADDLE_ID = "paddleocr-vl-1.6";
const ONNXTR_ID = "onnxtr-0.9";

/**
 * The only directory tree Bookforge ever deletes. Resolved and re-checked on
 * every use so no id, symlink or env var can escape it — a user-provided
 * interpreter (`BOOKFORGE_PADDLEOCR_PYTHON`, `.venv-paddleocr/`) is never ours.
 */
export const managedModelDir = (id: string) => {
  const root = resolve(process.cwd(), ".bookforge-models");
  const dir = resolve(root, id);
  if (dir === root || !dir.startsWith(root + sep)) throw new Error(`refusing to manage ${dir}`);
  return dir;
};
const venvDir = (id: string) => join(managedModelDir(id), "venv");
const venvPython = (id: string) =>
  process.platform === "win32" ? join(venvDir(id), "Scripts", "python.exe") : join(venvDir(id), "bin", "python");

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
const pythonPath = async (...candidates: (string | undefined)[]): Promise<string | null> => {
  for (const candidate of candidates) if (candidate && (await executable(candidate))) return candidate;
  return null;
};

const paddlePython = () =>
  pythonPath(
    process.env.BOOKFORGE_PADDLEOCR_PYTHON,
    venvPython(PADDLE_ID),
    join(process.cwd(), ".venv-paddleocr", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3")
  );

const onnxtrPython = () => pythonPath(process.env.BOOKFORGE_ONNXTR_PYTHON, venvPython(ONNXTR_ID));

const run = async (command: string, args: string[]): Promise<string> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output = (output + chunk).slice(-32_768)));
    child.stderr.on("data", (chunk: string) => (output = (output + chunk).slice(-32_768)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}\n${output}`));
    });
  });

/** Ours or the operator's, and what our own tree costs on disk. */
const runtimeStatus = async (id: string, python: string | null): Promise<ModelStatus> => {
  const managed = managedModelDir(id);
  return {
    installed: python !== null,
    source: python === null ? null : resolve(python).startsWith(managed + sep) ? "managed" : "external",
    diskBytes: await dirBytes(managed),
  };
};

/** An isolated venv under `.bookforge-models/<id>/`, never a shared one. */
const createVenv = async (id: string, minimumMinor = 0): Promise<string> => {
  const base = process.env.BOOKFORGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const version = (await run(base, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"])).trim();
  const [major, minor] = version.split(/\s+/).map(Number);
  if (major !== 3 || minor! < minimumMinor)
    throw new Error(
      `${base} is Python ${major}.${minor}; this model needs 3.${minimumMinor} or newer. ` +
        "Set BOOKFORGE_PYTHON to one that is."
    );
  await mkdir(managedModelDir(id), { recursive: true });
  await run(base, ["-m", "venv", venvDir(id)]);
  const python = venvPython(id);
  await run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
  return python;
};

const removeRuntime = async (id: string, name: string, weightsHome: string): Promise<string> => {
  const dir = managedModelDir(id);
  if (!(await stat(dir).catch(() => null))) return `No managed ${name} runtime on disk.`;
  await rm(dir, { recursive: true, force: true });
  return `Removed the managed ${name} runtime. Downloaded weights stay in ${weightsHome}.`;
};

export type ModelProvider = {
  info: Omit<ModelInfo, keyof ModelStatus | "loaded">;
  status(): Promise<ModelStatus>;
  create(): Promise<OcrEngine>;
  install(): Promise<string>;
  /** Deletes what `install` put on disk. Must only ever touch `managedModelDir`. */
  remove(): Promise<string>;
};

const paddleProvider: ModelProvider = {
  info: {
    id: PADDLE_ID,
    name: "PaddleOCR-VL",
    version: "1.6",
    description: "Document layout, multilingual OCR, tables and formulas.",
    capabilities: ["layout", "multilingual", "tables", "formulas"],
    installLabel: "Install runtime",
    firstRunNote: "The first comparison may download the official model weights.",
  },
  async status() {
    return await runtimeStatus(PADDLE_ID, await paddlePython());
  },
  async create() {
    const python = await paddlePython();
    if (!python) throw new Error("PaddleOCR-VL is not installed. Install it from the Models panel first.");
    return paddleEngine({ pythonPath: python });
  },
  async install() {
    if (await paddlePython()) return "PaddleOCR-VL is already installed.";
    const python = await createVenv(PADDLE_ID);
    await run(python, ["-m", "pip", "install", "paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.6.0"]);
    return "PaddleOCR-VL runtime installed. Official model weights download automatically on first use.";
  },
  async remove() {
    return await removeRuntime(PADDLE_ID, "PaddleOCR-VL", "the shared PaddleX/HuggingFace cache");
  },
};

const onnxtrProvider: ModelProvider = {
  info: {
    id: ONNXTR_ID,
    name: "OnnxTR",
    version: "0.9",
    description: "Pure ONNX, no PyTorch: layout, reading order and table structure on any CPU.",
    // no formulas: OnnxTR recognizes text, not math, so a formula is kept as a picture
    capabilities: ["layout", "multilingual", "tables"],
    installLabel: "Install runtime",
    firstRunNote: "The first comparison downloads about 275 MB of ONNX weights.",
  },
  async status() {
    return await runtimeStatus(ONNXTR_ID, await onnxtrPython());
  },
  async create() {
    const python = await onnxtrPython();
    if (!python) throw new Error("OnnxTR is not installed. Install it from the Models panel first.");
    return onnxtrEngine({ pythonPath: python });
  },
  async install() {
    if (await onnxtrPython()) return "OnnxTR is already installed.";
    const python = await createVenv(ONNXTR_ID, 11);
    // Intel Macs: onnxruntime ships arm64-only wheels from 1.24.1 onwards.
    const intelMac = process.platform === "darwin" && process.arch === "x64";
    if (intelMac) await run(python, ["-m", "pip", "install", "onnxruntime==1.23.2"]);
    await run(python, ["-m", "pip", "install", "onnxtr[cpu]==0.9.0"]);
    return "OnnxTR runtime installed. The ONNX weights download automatically on first use.";
  },
  async remove() {
    return await removeRuntime(ONNXTR_ID, "OnnxTR", "ONNXTR_CACHE_DIR");
  },
};

// One provider object is the entire extension point for future models. The
// studio and document pipeline never switch on model-specific behavior. OnnxTR
// is first because it is the one that runs everywhere.
const providers: ModelProvider[] = [onnxtrProvider, paddleProvider];
const provider = (id: string) => {
  const found = providers.find((candidate) => candidate.info.id === id);
  if (!found) throw new Error(`unknown OCR model: ${id}`);
  return found;
};

/** Adds a provider to the registry. The Studio picks it up with no other change. */
export function registerProvider(item: ModelProvider): void {
  providers.push(item);
}

// Keep-alive, like `ollama`: a model stays warm between requests and unloads
// itself once idle, so a comparison and the conversion that follows it pay the
// weight-loading cost once. Engines are refcounted; only the last user closes.
type Warm = { engine: Promise<OcrEngine>; users: number; idle?: ReturnType<typeof setTimeout> };
const warm = new Map<string, Warm>();
const idleMs = () => Number(process.env.BOOKFORGE_MODEL_IDLE_MS ?? 300_000);

const shutdown = async (entry: Warm) => {
  await entry.engine.then((engine) => engine.close?.()).catch(() => {});
};

const release = (id: string, entry: Warm) => {
  const cached = warm.get(id) === entry;
  if (!cached || idleMs() <= 0) {
    if (cached) warm.delete(id);
    void shutdown(entry);
    return;
  }
  entry.idle = setTimeout(() => {
    if (warm.get(id) !== entry) return;
    warm.delete(id);
    void shutdown(entry);
  }, idleMs());
  entry.idle.unref?.();
};

/**
 * Runs `use` against a warm engine for `id`, loading one if needed. A failure
 * evicts the engine so a crashed process never poisons the next request.
 */
export async function withModel<T>(id: string, use: (engine: OcrEngine) => Promise<T>): Promise<T> {
  let entry = warm.get(id);
  if (!entry) warm.set(id, (entry = { engine: provider(id).create(), users: 0 }));
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = undefined;
  entry.users++;
  try {
    return await use(await entry.engine);
  } catch (error) {
    if (warm.get(id) === entry) warm.delete(id);
    throw error;
  } finally {
    if (--entry.users === 0) release(id, entry);
  }
}

export async function listModels(): Promise<ModelInfo[]> {
  return await Promise.all(
    providers.map(async (item) => ({ ...item.info, ...(await item.status()), loaded: warm.has(item.info.id) }))
  );
}

export async function installModel(id: string): Promise<{ message: string }> {
  return { message: await provider(id).install() };
}

/** Frees memory now. An engine still serving a request closes when it finishes. */
export async function unloadModel(id: string): Promise<{ message: string }> {
  const { name } = provider(id).info;
  const entry = warm.get(id);
  if (!entry) return { message: `${name} is not loaded.` };
  warm.delete(id);
  if (entry.idle) clearTimeout(entry.idle);
  if (entry.users === 0) await shutdown(entry);
  return { message: `${name} unloaded from memory.` };
}

/** Destructive: unloads, then deletes the managed runtime from disk. */
export async function removeModel(id: string): Promise<{ message: string }> {
  await unloadModel(id);
  return { message: await provider(id).remove() };
}
