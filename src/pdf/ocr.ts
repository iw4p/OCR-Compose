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
import type { Block, DemotedRole } from "../contract.js";

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
  /** `fresh` skips the page cache read (the result is still written), so a
   *  timing sample measures real recognition work, never a cache hit. */
  recognize(png: Uint8Array, languages: string[], opts?: { fresh?: boolean }): Promise<OcrBlock[]>;
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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (text: string) =>
  text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/**
 * PaddleOCR-VL returns tables as HTML. Cells carry the inline dialect (§4.3),
 * so their text goes through the same escaping as prose. A table using
 * colspan/rowspan is refused — the flat `rows` grid cannot hold it, and a
 * degraded block is better than a silently reshaped one (§3.3).
 */
const htmlTable = (text: string): string[][] | null => {
  if (!/<table[\s>]/i.test(text)) return null;
  if (/\b(?:colspan|rowspan)\s*=\s*["']?\s*(?:[2-9]|\d\d)/i.test(text)) return null;
  const cell = (html: string) => prose(decodeEntities(html.replace(/<[^>]*>/g, " ")));
  const rows: string[][] = [];
  for (const row of text.matchAll(/<tr\b[^>]*>([\s\S]*?)(?:<\/tr\s*>|$)/gi))
    rows.push(
      // tolerates unclosed cells: a cell ends at its tag, the next cell, or the row
      [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<\/t[dh]\s*>|<t[dh]\b|<\/tr\s*>|$)/gi)].map((m) =>
        cell(m[1]!)
      )
    );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0) return null;
  // a short row is padded, never dropped — a missing cell is empty, not lost
  const grid = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  return grid.some((row) => row.some((value) => value !== "")) ? grid : null;
};

const tableRows = (text: string): string[][] | null => htmlTable(text) ?? markdownTable(text);

const FURNITURE = /header|footer|page[_ -]?number|^number$/;
const PAGE_NUMBER = /page[_ -]?number|^number$/;
// PaddleOCR-VL's `vision_footnote` is figure-associated text — an illustration
// caption, not a page footnote — and `*_title` labels caption their region.
const CAPTION = /caption|vision[_ -]?footnote|(?:figure|chart|image|table)[_ -]?title/;
const VISION = /image|figure|chart|photo|seal|stamp/;

/**
 * The demoted role furniture keeps (I3). `DemotedRole` is the contract's own
 * vocabulary (`DEMOTED_ROLES`), so a name the emitters do not hide is a type
 * error here rather than a page of running heads in the finished book.
 */
const furnitureRole = (label: string): DemotedRole =>
  PAGE_NUMBER.test(label) ? "page-number" : /footer/.test(label) ? "running-footer" : "running-header";

const finite = (block: OcrBlock) => Number.isFinite(block.x + block.y + block.w + block.h);

/**
 * The figure regions of a page: a vision label with no recognized text (a
 * chart the provider did read stays text rather than losing it), plausibly
 * content-sized, and not the page itself. `pdfToBook` crops these out of the
 * page render and writes them under the names `ocrImageFile` derives, so the
 * mapper below stays a pure function of the OCR blocks.
 */
export function ocrFigures(blocks: OcrBlock[]): OcrBlock[] {
  return blocks.filter((block) => {
    const label = block.label.toLowerCase();
    if (FURNITURE.test(label) || CAPTION.test(label) || !VISION.test(label)) return false;
    if (block.text.trim() !== "") return false;
    return finite(block) && block.w >= 0.02 && block.h >= 0.02 && block.w * block.h < 0.9;
  });
}

/** Deterministic asset name for a cropped figure: page plus its bounding box. */
export function ocrImageFile(page: number, block: OcrBlock): string {
  const box = [block.x, block.y, block.w, block.h].map((n) => n.toFixed(4)).join(",");
  const hash = createHash("sha1").update(`${page}|${box}`).digest("hex").slice(0, 12);
  return `assets/fig-${page}-${hash}.png`;
}

/** Caption below or above a figure, overlapping it horizontally. */
const adjacent = (caption: OcrBlock, figure: OcrBlock) => {
  const overlap = Math.min(caption.x + caption.w, figure.x + figure.w) - Math.max(caption.x, figure.x);
  if (overlap < caption.w * 0.5) return false;
  return Math.max(figure.y - (caption.y + caption.h), caption.y - (figure.y + figure.h)) < 0.05;
};

/**
 * Preserve the semantic boundaries a document model already found. Native
 * line unwrapping is deliberately not involved here.
 */
export function ocrBlocksToBookBlocks(blocks: OcrBlock[], page: number): Block[] {
  const out: Block[] = [];
  // source geometry, parallel to `out`; it binds captions below and then dies
  // here — coordinates never reach book.json (I2).
  const boxes: OcrBlock[] = [];
  const figures = new Set(ocrFigures(blocks));
  const emit = (block: Block, source: OcrBlock) => {
    out.push(block);
    boxes.push(source);
  };

  for (const block of blocks) {
    if (!finite(block)) continue;
    const label = block.label.toLowerCase();
    // I3: furniture is demoted, not deleted. `epub3` emits demoted blocks
    // hidden, so the running head stays off the page and one field edit brings
    // it back. A furniture region with no text has nothing to preserve.
    if (FURNITURE.test(label)) {
      const text = prose(block.text);
      if (text) emit({ type: "text", role: furnitureRole(label), text, page }, block);
      continue;
    }
    if (figures.has(block)) {
      emit({ type: "image", file: ocrImageFile(page, block), page }, block);
      continue;
    }
    const raw = block.text.trim();
    if (!raw) continue;

    if (/formula|equation/.test(label)) {
      emit({ type: "formula", display: true, tex: raw, page }, block);
      continue;
    }
    if (/table/.test(label) && !CAPTION.test(label)) {
      const rows = tableRows(raw);
      emit(
        rows ? { type: "table", rows, page } : { type: "text", role: "table-source", text: prose(raw), page },
        block
      );
      continue;
    }
    if (/list/.test(label)) {
      const items = raw
        .split(/\n+/)
        .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .map((item) => [{ type: "text", text: prose(item), page }] satisfies Block[]);
      if (items.length > 0) {
        emit({ type: "list", ordered: /^\s*\d+[.)]/.test(raw), items, page }, block);
        continue;
      }
    }

    const text = prose(raw);
    const letters = raw.replace(/[^\p{L}]/gu, "");
    const inferredCapsTitle =
      label === "text" && raw.length <= 80 && letters !== "" && letters === letters.toUpperCase();
    if (CAPTION.test(label)) emit({ type: "text", role: "caption", text, page }, block);
    else if (/doc[_ -]?title/.test(label)) emit({ type: "heading", level: 1, text, page }, block);
    else if (/paragraph[_ -]?title|section[_ -]?title|title/.test(label) || inferredCapsTitle)
      emit({ type: "heading", level: 2, text, page }, block);
    else {
      const role = /footnote/.test(label) ? "footnote-source" : undefined;
      emit({ type: "text", text, page, ...(role && { role }) }, block);
    }
  }

  // The one sliver of `bind` (tool 10) this page's geometry makes free: a
  // caption touching a figure becomes that figure's caption. Anything
  // unmatched stays a `role: "caption"` paragraph.
  const bound = new Set<number>();
  for (let i = 0; i < out.length; i++) {
    const block = out[i]!;
    if (block.type !== "text" || block.role !== "caption") continue;
    for (const j of [i + 1, i - 1]) {
      const figure = out[j];
      if (!figure || figure.type !== "image" || figure.caption !== undefined) continue;
      if (!adjacent(boxes[i]!, boxes[j]!)) continue;
      figure.caption = block.text;
      bound.add(i);
      break;
    }
  }
  return bound.size > 0 ? out.filter((_, i) => !bound.has(i)) : out;
}

type HelperReply = { id: number; error?: string } & Record<string, unknown>;
type Pending = { resolve: (reply: HelperReply) => void; reject: (error: Error) => void };

/**
 * A model's Python helper, held open for the whole book: one JSON request per
 * line in, one reply per line out, matched by `id`. Model weights load once.
 */
class HelperSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private closing = false;

  constructor(
    private readonly name: string,
    private readonly pythonPath: string,
    private readonly helperPath: string,
    private readonly args: string[]
  ) {}

  async recognize<T>(request: Record<string, unknown>): Promise<T> {
    await this.start();
    const id = this.nextId++;
    return (await new Promise<HelperReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(JSON.stringify({ ...request, id }) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    })) as T;
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
      throw new Error(`${this.name} helper not found at ${this.helperPath}`);
    });
    const child = spawn(this.pythonPath, [this.helperPath, ...this.args], { stdio: ["pipe", "pipe", "pipe"] });
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
          new Error(`${this.name} helper exited with code ${code ?? "unknown"}` + (detail ? `:\n${detail}` : ""))
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
        this.failAll(new Error(`invalid output from the ${this.name} helper: ${line.slice(0, 200)}`));
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(`${this.name} failed: ${reply.error}`));
      else pending.resolve(reply);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/**
 * The `pagecache` of DESIGN tool 16 (P6): one JSON file per recognized page,
 * named by everything that produced it, so a long run resumes and a page
 * compared in the Studio is not recognized — or paid for — twice.
 *
 * `identity` must name the provider *and* the output contract of the adapter
 * around it (model, version, the adapter's own revision), because an entry one
 * provider wrote never suits another. `dir` is per provider, so one provider's results can be
 * deleted without touching another's; `null` disables the cache. A cache that
 * cannot be read, parsed or written is a miss, never a failed conversion.
 */
export function ocrCache(dir: string | null, identity: string) {
  return async (
    png: Uint8Array,
    languages: string[],
    // the key is also a usable temporary filename for the page image
    recognize: (key: string) => Promise<OcrBlock[]>,
    // fresh = measure real work: skip the read, still write the result
    fresh = false
  ): Promise<OcrBlock[]> => {
    const key = createHash("sha256")
      .update(identity + "\0")
      .update(png)
      .update("\0" + languages.join(","))
      .digest("hex");
    if (!dir) return await recognize(key);
    const path = join(dir, `${key}.json`);
    const hit: unknown = fresh ? null : await readFile(path, "utf8").then(JSON.parse).catch(() => null);
    if (Array.isArray(hit)) return hit as OcrBlock[];
    const blocks = await recognize(key);
    await mkdir(dir, { recursive: true })
      .then(() => writeFile(path, JSON.stringify(blocks)))
      .catch(() => {});
    return blocks;
  };
}

/** Page images a helper reads by path: written under the cache key, then removed. */
function pageImages(prefix: string) {
  let dir: string | null = null;
  return {
    async use<T>(key: string, png: Uint8Array, run: (path: string) => Promise<T>): Promise<T> {
      dir ??= await mkdtemp(join(tmpdir(), prefix));
      const path = join(dir, `${key}.png`);
      await writeFile(path, png);
      try {
        return await run(path);
      } finally {
        await rm(path, { force: true });
      }
    },
    async clean() {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = null;
    },
  };
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
  const pythonPath = opts.pythonPath ?? process.env.OCR_COMPOSE_PADDLEOCR_PYTHON ?? "python3";
  const helperPath =
    opts.helperPath ?? fileURLToPath(new URL("../../tools/ocr-paddle.py", import.meta.url));
  const device = opts.device ?? process.env.OCR_COMPOSE_PADDLEOCR_DEVICE;
  const vlBackend = opts.vlBackend ?? process.env.OCR_COMPOSE_PADDLEOCR_VL_BACKEND;
  const vlServerUrl = opts.vlServerUrl ?? process.env.OCR_COMPOSE_PADDLEOCR_VL_SERVER_URL;
  const vlModelName = opts.vlModelName ?? process.env.OCR_COMPOSE_PADDLEOCR_VL_MODEL_NAME;
  const cacheDir = opts.cacheDir === undefined ? ".ocr-compose-cache/ocr-paddle-vl-1.6" : opts.cacheDir;
  const session = new HelperSession("PaddleOCR-VL", pythonPath, helperPath, [
    ...(device ? ["--device", device] : []),
    ...(vlBackend ? ["--vl-backend", vlBackend] : []),
    ...(vlServerUrl ? ["--vl-server-url", vlServerUrl] : []),
    ...(vlModelName ? ["--vl-model-name", vlModelName] : []),
  ]);
  // the suffix is this helper's output contract, not the model: results cached
  // before figure regions were kept have no illustrations in them
  const cache = ocrCache(cacheDir, "PaddleOCR-VL-1.6+figures");
  const images = pageImages("ocr-compose-paddleocr-");

  return {
    name: "PaddleOCR-VL 1.6",
    recognize(png, languages, opts) {
      return cache(
        png,
        languages,
        (key) =>
          images.use(key, png, async (path) => {
            const reply = await session.recognize<{ blocks?: OcrBlock[] }>({ path });
            return reply.blocks ?? [];
          }),
        opts?.fresh
      );
    },
    async close() {
      await session.close();
      await images.clean();
    },
  };
}
