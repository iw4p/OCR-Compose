// Fast mode: the VLM step of PaddleOCR-VL served through MLX on Apple
// Silicon. PaddlePaddle has no Apple-GPU backend, so on a Mac it computes on
// CPU; MLX is Apple's ML framework and runs the same model on the machine's
// GPU — measured here at roughly 8× the CPU rate. Layout analysis stays local
// either way. This module owns the marker that says the user wants fast mode
// and the `mlx_vlm.server` child process; whether the platform supports it and
// whether installing into the Python environment is allowed are the caller's
// judgments (see registry.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** The VLM the server is asked for — the same weights the CPU path uses. */
export const FAST_MODE_VL_MODEL = "PaddlePaddle/PaddleOCR-VL-1.6";

export type FastModeStatus = {
  /** darwin/arm64 — the only platform this acceleration exists for. */
  supported: boolean;
  /** mlx_vlm.server exists beside the model's Python interpreter. */
  installed: boolean;
  /** The user switched it on (the marker file exists). */
  enabled: boolean;
  /** A server this process started is currently alive. */
  running: boolean;
  /** What enabling costs to download when mlx-vlm is not installed yet. */
  downloadBytes: number;
};

export const fastModeSupported = () => process.platform === "darwin" && process.arch === "arm64";

const markerPath = (root: string) => resolve(root, ".ocr-compose-models", "fast-mode");
const serverBin = (python: string) => join(dirname(python), "mlx_vlm.server");
const port = () => Number(process.env.OCR_COMPOSE_FAST_MODE_PORT ?? 8111);
export const fastServerUrl = () => `http://127.0.0.1:${port()}/`;

const exists = async (path: string) => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export async function fastModeStatus(python: string | null, root = process.cwd()): Promise<FastModeStatus> {
  return {
    supported: fastModeSupported(),
    installed: python !== null && (await exists(serverBin(python))),
    enabled: await exists(markerPath(root)),
    running: owned !== null,
    downloadBytes: 300_000_000,
  };
}

/**
 * Switch fast mode on. Installs mlx-vlm first when it is missing — but only
 * into an environment we created (`allowInstall`); an operator's own
 * environment is never written to, they get the command to run instead.
 */
export async function enableFastMode(
  python: string,
  opts: { allowInstall: boolean; onLog?: (line: string) => void; root?: string; install?: (python: string) => Promise<void> },
): Promise<string> {
  const root = opts.root ?? process.cwd();
  if (!(await exists(serverBin(python)))) {
    if (!opts.allowInstall)
      throw new Error(
        "This Python environment is yours, so OCR Compose will not install into it. Add the mlx extra yourself: " +
          "uv pip install --python .venv-paddleocr/bin/python -r tools/paddle/pyproject.toml --extra mlx",
      );
    opts.onLog?.("Downloading MLX and mlx-vlm (about 300 MB)…");
    await (opts.install ?? installMlx)(python);
  }
  await mkdir(dirname(markerPath(root)), { recursive: true });
  await writeFile(markerPath(root), "on\n");
  return "Fast mode on. The next page runs the recognizer on this Mac's GPU.";
}

const installMlx = async (python: string): Promise<void> =>
  await new Promise((done, fail) => {
    const child = spawn(python, ["-m", "pip", "install", "mlx-vlm>=0.3.11"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (err = (err + chunk).slice(-8_192)));
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? done() : fail(new Error(`pip install mlx-vlm failed (${code})\n${err}`))));
  });

/** Switch fast mode off and stop any server this process started. */
export async function disableFastMode(root = process.cwd()): Promise<string> {
  const was = await exists(markerPath(root));
  await rm(markerPath(root), { force: true });
  await stopFastServer();
  return was ? "Fast mode off. Recognition runs on the CPU again." : "Fast mode is not enabled.";
}

// One server per process, started when an engine warms up in fast mode and
// stopped when that engine closes (registry.ts ties the lifetimes together).
let owned: ChildProcess | null = null;

const healthy = async (): Promise<boolean> => {
  try {
    const response = await fetch(new URL("health", fastServerUrl()), { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const killOwned = () => owned?.kill();

/**
 * The server the engine should talk to, starting one if none answers. A server
 * someone else runs on the port is used as-is and never stopped by us. `null`
 * means fast mode cannot come up right now — the caller falls back to CPU
 * rather than failing the conversion.
 */
export async function ensureFastServer(python: string, onLog?: (line: string) => void): Promise<string | null> {
  if (await healthy()) return fastServerUrl();
  if (!(await exists(serverBin(python)))) return null;

  onLog?.("Starting the MLX server…");
  const child = spawn(serverBin(python), ["--port", String(port())], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (err = (err + chunk).slice(-8_192)));
  child.once("close", () => {
    if (owned === child) owned = null;
    process.removeListener("exit", killOwned);
  });
  owned = child;
  process.once("exit", killOwned);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && owned === child) {
    if (await healthy()) return fastServerUrl();
    await new Promise((tick) => setTimeout(tick, 500));
  }
  onLog?.(`The MLX server did not come up — falling back to CPU.${err ? ` Its last words: ${err.slice(-500)}` : ""}`);
  await stopFastServer();
  return null;
}

/** Stops the server this process started; a server we merely found is left alone. */
export async function stopFastServer(): Promise<void> {
  const child = owned;
  if (!child) return;
  owned = null;
  await new Promise<void>((done) => {
    child.once("close", () => done());
    if (!child.kill()) done();
  });
}
