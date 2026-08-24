// OCR adapter: scan-backed PDF pages are rendered and parsed by a model
// provider. Providers return semantic layout blocks; they never impersonate
// native PDF lines. The model is an optional Python dependency and stays
// loaded in one helper process for the whole book.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block } from "../contract.js";

/** One Paddle layout block, normalized from a top-left origin. */
export type OcrBlock = {
  text: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export interface OcrEngine {
  name: string;
  recognize(png: Uint8Array, languages: string[]): Promise<OcrBlock[]>;
  /** Releases a long-lived model process and temporary page images. */
  close?(): Promise<void>;
}

const escapeDialect = (text: string) => text.replace(/[\\*$[\]^]/g, (char) => "\\" + char);
const prose = (text: string) =>
  escapeDialect(text.replace(/\r\n?/g, "\n").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim());

const markdownTable = (text: string): string[][] | null => {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !lines.some((line) => line.includes("|"))) return null;
  const cells = (line: string) =>
    line.replace(/^\||\|$/g, "").split("|").map((cell) => prose(cell));
  const rows = lines.map(cells).filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  return rows.length > 0 && rows.every((row) => row.length === rows[0]!.length) ? rows : null;
};

/**
 * Preserve the semantic boundaries a document model already found. Native
 * line unwrapping is deliberately not involved here.
 */
export function ocrBlocksToBookBlocks(blocks: OcrBlock[], page: number): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (!Number.isFinite(block.x + block.y + block.w + block.h)) continue;
    const raw = block.text.trim();
    if (!raw) continue;
    const label = block.label.toLowerCase();
    if (/header|footer|page[_ -]?number|^number$/.test(label)) continue;

    if (/formula|equation/.test(label)) {
      out.push({ type: "formula", display: true, tex: raw, page });
      continue;
    }
    if (/table/.test(label)) {
      const rows = markdownTable(raw);
      out.push(rows ? { type: "table", rows, page } : { type: "text", role: "table-source", text: prose(raw), page });
      continue;
    }
    if (/list/.test(label)) {
      const items = raw
        .split(/\n+/)
        .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .map((item) => [{ type: "text", text: prose(item), page }] satisfies Block[]);
      if (items.length > 0) {
        out.push({ type: "list", ordered: /^\s*\d+[.)]/.test(raw), items, page });
        continue;
      }
    }

    const text = prose(raw);
    const letters = raw.replace(/[^\p{L}]/gu, "");
    const inferredCapsTitle =
      label === "text" && raw.length <= 80 && letters !== "" && letters === letters.toUpperCase();
    if (/doc[_ -]?title/.test(label)) out.push({ type: "heading", level: 1, text, page });
    else if (/paragraph[_ -]?title|section[_ -]?title|title/.test(label) || inferredCapsTitle)
      out.push({ type: "heading", level: 2, text, page });
    else {
      const role = /caption|figure[_ -]?title/.test(label)
        ? "caption"
        : /footnote/.test(label)
          ? "footnote-source"
          : undefined;
      out.push({ type: "text", text, page, ...(role && { role }) });
    }
  }
  return out;
}

type HelperReply = { id: number; blocks?: OcrBlock[]; error?: string };
type Pending = { resolve: (blocks: OcrBlock[]) => void; reject: (error: Error) => void };

class PaddleSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private closing = false;

  constructor(
    private readonly pythonPath: string,
    private readonly helperPath: string,
    private readonly options: {
      device?: string;
      vlBackend?: string;
      vlServerUrl?: string;
      vlModelName?: string;
    }
  ) {}

  async recognize(path: string): Promise<OcrBlock[]> {
    await this.start();
    const id = this.nextId++;
    return await new Promise<OcrBlock[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(JSON.stringify({ id, path }) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.stdin.end();
    });
    this.child = null;
  }

  private async start(): Promise<void> {
    if (this.child) return;
    await access(this.helperPath).catch(() => {
      throw new Error(`PaddleOCR-VL helper not found at ${this.helperPath}`);
    });
    const args = [
      this.helperPath,
      ...(this.options.device ? ["--device", this.options.device] : []),
      ...(this.options.vlBackend ? ["--vl-backend", this.options.vlBackend] : []),
      ...(this.options.vlServerUrl ? ["--vl-server-url", this.options.vlServerUrl] : []),
      ...(this.options.vlModelName ? ["--vl-model-name", this.options.vlModelName] : []),
    ];
    const child = spawn(this.pythonPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_384);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code) => {
      if (!this.closing && (code !== 0 || this.pending.size > 0)) {
        const detail = this.stderr.trim();
        this.failAll(
          new Error(
            `PaddleOCR-VL helper exited with code ${code ?? "unknown"}` +
              (detail ? `:\n${detail}` : "")
          )
        );
      }
      this.child = null;
    });
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let reply: HelperReply;
      try {
        reply = JSON.parse(line) as HelperReply;
      } catch {
        this.failAll(new Error(`invalid output from PaddleOCR-VL helper: ${line.slice(0, 200)}`));
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(`PaddleOCR-VL failed: ${reply.error}`));
      else pending.resolve(reply.blocks ?? []);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export type PaddleEngineOptions = {
  /** Python 3.9–3.13 environment containing paddlepaddle and paddleocr. */
  pythonPath?: string;
  helperPath?: string;
  /** Paddle device string, for example `cpu` or `gpu:0`. */
  device?: string;
  /** Optional accelerated VLM service; layout analysis remains local. */
  vlBackend?: string;
  vlServerUrl?: string;
  vlModelName?: string;
  cacheDir?: string | null;
};

export function paddleEngine(opts: PaddleEngineOptions = {}): OcrEngine {
  const pythonPath = opts.pythonPath ?? process.env.BOOKFORGE_PADDLEOCR_PYTHON ?? "python3";
  const helperPath =
    opts.helperPath ?? fileURLToPath(new URL("../../tools/ocr-paddle.py", import.meta.url));
  const device = opts.device ?? process.env.BOOKFORGE_PADDLEOCR_DEVICE;
  const vlBackend = opts.vlBackend ?? process.env.BOOKFORGE_PADDLEOCR_VL_BACKEND;
  const vlServerUrl = opts.vlServerUrl ?? process.env.BOOKFORGE_PADDLEOCR_VL_SERVER_URL;
  const vlModelName = opts.vlModelName ?? process.env.BOOKFORGE_PADDLEOCR_VL_MODEL_NAME;
  const cacheDir = opts.cacheDir === undefined ? ".bookforge-cache/ocr-paddle-vl-1.6" : opts.cacheDir;
  const session = new PaddleSession(pythonPath, helperPath, {
    ...(device && { device }),
    ...(vlBackend && { vlBackend }),
    ...(vlServerUrl && { vlServerUrl }),
    ...(vlModelName && { vlModelName }),
  });
  let workDir: string | null = null;

  return {
    name: "PaddleOCR-VL 1.6",
    async recognize(png, languages) {
      const key = createHash("sha256")
        .update("PaddleOCR-VL-1.6\0")
        .update(png)
        .update("\0" + languages.join(","))
        .digest("hex");
      const cachePath = cacheDir ? join(cacheDir, `${key}.json`) : null;
      if (cachePath) {
        const hit = await readFile(cachePath, "utf8").catch(() => null);
        if (hit !== null) return JSON.parse(hit) as OcrBlock[];
      }

      workDir ??= await mkdtemp(join(tmpdir(), "bookforge-paddleocr-"));
      const imagePath = join(workDir, `${key}.png`);
      await writeFile(imagePath, png);
      try {
        const blocks = await session.recognize(imagePath);
        if (cachePath) {
          await mkdir(cacheDir!, { recursive: true });
          await writeFile(cachePath, JSON.stringify(blocks));
        }
        return blocks;
      } finally {
        await rm(imagePath, { force: true });
      }
    },
    async close() {
      await session.close();
      if (workDir) await rm(workDir, { recursive: true, force: true });
      workDir = null;
    },
  };
}
