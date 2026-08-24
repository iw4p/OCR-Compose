import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paddleEngine, type OcrEngine } from "../pdf/ocr.js";

export type ModelCapability = "layout" | "multilingual" | "tables" | "formulas";

export type ModelInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: ModelCapability[];
  runtime: "python";
  installed: boolean;
  installLabel: string;
  firstRunNote: string;
};

const PADDLE_ID = "paddleocr-vl-1.6";
const managedRoot = () => join(process.cwd(), ".bookforge-models", PADDLE_ID, "venv");
const managedPython = () =>
  process.platform === "win32"
    ? join(managedRoot(), "Scripts", "python.exe")
    : join(managedRoot(), "bin", "python");

const executable = async (path: string) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export async function paddlePythonPath(): Promise<string | null> {
  const candidates = [
    process.env.BOOKFORGE_PADDLEOCR_PYTHON,
    managedPython(),
    join(process.cwd(), ".venv-paddleocr", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  return null;
}

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

type ModelProvider = {
  info: Omit<ModelInfo, "installed">;
  installed(): Promise<boolean>;
  create(): Promise<OcrEngine>;
  install(): Promise<string>;
};

const paddleProvider: ModelProvider = {
  info: {
    id: PADDLE_ID,
    name: "PaddleOCR-VL",
    version: "1.6",
    description: "Document layout, multilingual OCR, tables and formulas.",
    capabilities: ["layout", "multilingual", "tables", "formulas"],
    runtime: "python",
    installLabel: "Install runtime",
    firstRunNote: "The first comparison may download the official model weights.",
  },
  async installed() {
    return (await paddlePythonPath()) !== null;
  },
  async create() {
    const pythonPath = await paddlePythonPath();
    if (!pythonPath)
      throw new Error("PaddleOCR-VL is not installed. Install it from the Models panel first.");
    return paddleEngine({ pythonPath });
  },
  async install() {
    if (await paddlePythonPath()) return "PaddleOCR-VL is already installed.";
    const basePython = process.env.BOOKFORGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    await mkdir(join(process.cwd(), ".bookforge-models", PADDLE_ID), { recursive: true });
    await run(basePython, ["-m", "venv", managedRoot()]);
    const python = managedPython();
    await run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
    await run(python, ["-m", "pip", "install", "paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.6.0"]);
    return "PaddleOCR-VL runtime installed. Official model weights download automatically on first use.";
  },
};

// One provider object is the entire extension point for future models. The
// studio and document pipeline never switch on model-specific behavior.
const providers: ModelProvider[] = [paddleProvider];
const provider = (id: string) => {
  const found = providers.find((candidate) => candidate.info.id === id);
  if (!found) throw new Error(`unknown OCR model: ${id}`);
  return found;
};

export async function listModels(): Promise<ModelInfo[]> {
  return await Promise.all(providers.map(async (item) => ({ ...item.info, installed: await item.installed() })));
}

export async function createModel(id: string): Promise<OcrEngine> {
  return await provider(id).create();
}

export async function installModel(id: string): Promise<{ message: string }> {
  return { message: await provider(id).install() };
}
