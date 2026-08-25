// One adapter for the OpenAI-compatible `/v1/chat/completions` vision API, so
// Ollama, LM Studio, vLLM, OpenRouter and hosted APIs all work with no code per
// model. Nothing is installed: the endpoint is configured with `BOOKFORGE_VLM_*`
// and the page images go wherever it points — which may not be this machine.
import { ocrCache, type OcrBlock, type OcrEngine } from "../pdf/ocr.js";
import type { ModelProvider, ModelStatus } from "./registry.js";

export const VLM_ID = "openai-vlm";

/** Its own directory, so clearing one provider's pages leaves the other's. */
export const VLM_CACHE_DIR = `.bookforge-cache/ocr-${VLM_ID}`;

export type VlmConfig = { url: string; model: string; apiKey: string };

/** Defaults to a local Ollama, so the zero-config case never leaves the machine. */
export const vlmConfig = (): VlmConfig => ({
  url: (process.env.BOOKFORGE_VLM_URL ?? "http://localhost:11434/v1").replace(/\/+$/, ""),
  model: process.env.BOOKFORGE_VLM_MODEL ?? "qwen2.5vl",
  apiKey: process.env.BOOKFORGE_VLM_API_KEY ?? "",
});

// Loopback, link-local, `.local` and RFC1918 addresses stay on the machine or
// its LAN; anything else is a third party the operator must see before running.
const PRIVATE =
  /^(?:localhost|[^.]+\.localhost|.+\.local|\[?::1\]?|127(?:\.\d+){3}|0\.0\.0\.0|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|169\.254(?:\.\d+){2})$/i;

/** Where pages are sent, and whether that is off this machine. Shown in the Studio. */
export function vlmEndpoint(): { url: string; local: boolean } {
  const { url } = vlmConfig();
  try {
    return { url, local: PRIVATE.test(new URL(url).hostname) };
  } catch {
    return { url, local: false };
  }
}

const LABELS =
  "doc_title, paragraph_title, text, list, table, table_caption, figure, figure_caption, formula, header, footer, page_number, footnote";

const instruction = (languages: string[]) =>
  [
    'Analyse this page image and return JSON only, as {"blocks": [...]}, in reading order.',
    `Each block is {"label": one of ${LABELS}, "text": string, "bbox": [x0, y0, x1, y1]}.`,
    "bbox is the top-left and bottom-right corner as a fraction of the page, from 0 to 1.",
    "Transcribe text exactly; never translate, summarise or explain it.",
    'Write a table as an HTML <table> and a formula as LaTeX, both inside "text".',
    'Leave "text" empty for a picture, photograph, chart or diagram, and give its bbox precisely.',
    languages.length > 0 ? `The page may be in: ${languages.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number =>
  typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;

const snippet = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

const VISION_WORDS = new Set(
  "image figure fig picture photo photograph illustration chart diagram graph graphic seal stamp logo".split(" ")
);

/**
 * Model-specific label names collapse to the vocabulary `ocrBlocksToBookBlocks`
 * switches on. Order matters: `table_caption` is a caption, not a table.
 * Anything unrecognized becomes prose rather than being invented into a heading.
 */
export function vlmLabel(raw: string): string {
  const label = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (/caption/.test(label)) return "caption";
  if (/formula|equation|math/.test(label)) return "formula";
  if (/table/.test(label)) return "table";
  if (/page_?number|folio|^number$/.test(label)) return "number";
  if (/footnote/.test(label)) return "footnote";
  if (/doc_title|chapter_title|^title$|^h1$/.test(label)) return "doc_title";
  // before the furniture rules: "section header" is a heading, "page header" is not
  if (/title|heading|subtitle|section|^h[2-6]$/.test(label)) return "paragraph_title";
  if (/header|running_head/.test(label)) return "header";
  if (/footer/.test(label)) return "footer";
  if (/list|bullet/.test(label)) return "list";
  // whole words only: "paragraph" is not a graph
  if (label.split("_").some((word) => VISION_WORDS.has(word.replace(/s$/, "")))) return "image";
  return "text";
}

const textOf = (entry: Record<string, unknown>): string => {
  const value = entry.text ?? entry.content ?? entry.html ?? entry.latex ?? entry.value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join("\n");
  return "";
};

const BOX_KEYS = ["bbox", "bbox_2d", "box", "bounding_box", "coordinates", "rect", "position"];

/** Accepts `[x0,y0,x1,y1]`, `[[x0,y0],[x1,y1]]`, `{x,y,w,h}` and corner-pair objects. */
const corners = (entry: Record<string, unknown>): number[] => {
  const raw = BOX_KEYS.map((key) => entry[key]).find((value) => value !== undefined);
  if (Array.isArray(raw)) {
    const flat = raw.flat(2).map(num);
    if (flat.length === 4) return flat;
  }
  const box = isRecord(raw) ? raw : entry;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (box[key] !== undefined) return num(box[key]);
    return NaN;
  };
  if (box.x2 !== undefined) return [pick("x1"), pick("y1"), pick("x2"), pick("y2")];
  const [x, y, w, h] = [pick("x", "x0", "left"), pick("y", "y0", "top"), pick("w", "width"), pick("h", "height")];
  if (Number.isFinite(w) && Number.isFinite(h)) return [x, y, x + w, y + h];
  return [x, y, pick("x1", "right"), pick("y1", "bottom")];
};

/**
 * A general VLM answers with prose, code fences, JSON, or one object per line.
 * Take the first structure that parses. `null` means nothing structured came
 * back at all — an error, not an empty page.
 */
const entries = (reply: string): unknown[] | null => {
  const body = reply.replace(/```[a-z]*/gi, "").trim();
  const cut = (open: string, close: string) => {
    const [start, end] = [body.indexOf(open), body.lastIndexOf(close)];
    return start >= 0 && end > start ? body.slice(start, end + 1) : "";
  };
  for (const candidate of [body, cut("[", "]"), cut("{", "}")]) {
    if (!candidate) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(value)) return value;
    // the array lives under whatever key the model chose; the named ones win so
    // that a stray `{"languages": [...], "blocks": [...]}` is not read backwards
    if (isRecord(value)) {
      const named = ["blocks", "regions", "elements", "layout", "results", "items", "data"];
      const list = named.map((key) => value[key]).find(Array.isArray) ?? Object.values(value).find(Array.isArray);
      if (list) return list;
    }
  }
  const blockish = (value: unknown) =>
    isRecord(value) && ["text", "label", "type", "bbox", "bbox_2d", "box", "content"].some((key) => key in value);
  const lines = body.split("\n").map((line) => {
    try {
      return JSON.parse(line.trim()) as unknown;
    } catch {
      return null;
    }
  });
  const objects = lines.filter(blockish);
  return objects.length > 0 ? objects : null;
};

/** PNG IHDR: width and height are the big-endian u32 at bytes 16 and 20. */
const pngSize = (png: Uint8Array): { w: number; h: number } | null => {
  if (png.byteLength < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const [w, h] = [view.getUint32(16), view.getUint32(20)];
  return w > 0 && h > 0 ? { w, h } : null;
};

/**
 * Models answer in unit fractions, in percent, in the 0–1000 grid many are
 * trained on, or in page pixels, and none of them say which. Pick the divisor
 * whose boxes all fit on the page and fill it most tightly.
 */
const pageScale = (quads: number[][], size: { w: number; h: number } | null): [number, number] => {
  const usable = quads.filter((quad) => quad.every((value) => Number.isFinite(value)));
  const bound = (a: number, b: number) => Math.max(0, ...usable.map((quad) => Math.max(quad[a]!, quad[b]!)));
  const [maxX, maxY] = [bound(0, 2), bound(1, 3)];
  const candidates: [number, number][] = [
    [1, 1],
    [100, 100],
    [1000, 1000],
    ...(size ? [[size.w, size.h] as [number, number]] : []),
  ];
  let best: [number, number] = [1, 1];
  let fill = -1;
  for (const [sx, sy] of candidates)
    if (maxX <= sx * 1.02 && maxY <= sy * 1.02 && maxX / sx + maxY / sy > fill)
      [best, fill] = [[sx, sy], maxX / sx + maxY / sy];
  return best;
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * One chat reply into blocks. Malformed entries are skipped rather than
 * failing the page; only a reply with no structure at all is an error.
 */
export function vlmBlocks(reply: string, size: { w: number; h: number } | null, where = "the model"): OcrBlock[] {
  const list = entries(reply);
  if (!list)
    throw new Error(
      `${where} did not return document blocks. Point BOOKFORGE_VLM_MODEL at a vision model that can follow JSON instructions. ` +
        (reply.trim() ? `The reply began: ${snippet(reply)}` : "The reply was empty.")
    );
  const rows = list
    // a bare list of strings is a transcription: keep the lines, lose the geometry
    .map((entry) => (typeof entry === "string" ? { text: entry } : entry))
    .filter(isRecord)
    .map((entry) => ({
      text: textOf(entry),
      label: vlmLabel(String(entry.label ?? entry.type ?? entry.category ?? "")),
      quad: corners(entry),
    }));
  const [sx, sy] = pageScale(
    rows.map((row) => row.quad),
    size
  );

  const blocks: OcrBlock[] = [];
  for (const row of rows) {
    // only a picture carries meaning without text; an empty paragraph is noise
    if (row.text.trim() === "" && row.label !== "image") continue;
    const [x0, y0, x1, y1] = row.quad.map((value, i) => clamp(value / (i % 2 ? sy : sx)));
    const usable = row.quad.every((value) => Number.isFinite(value)) && x1! > x0! && y1! > y0!;
    // An unusable box must never become a croppable region: text keeps its place
    // in reading order with an inert empty box, and a picture nobody can locate
    // is dropped rather than cropped from invented coordinates.
    if (usable) blocks.push({ text: row.text, label: row.label, x: x0!, y: y0!, w: x1! - x0!, h: y1! - y0! });
    else if (row.text.trim() !== "") blocks.push({ text: row.text, label: row.label, x: 0, y: 0, w: 0, h: 0 });
  }
  return blocks;
}

const auth = (config: VlmConfig): Record<string, string> =>
  config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};

const request = (png: Uint8Array, languages: string[], config: VlmConfig, json: boolean) => ({
  model: config.model,
  temperature: 0,
  ...(json && { response_format: { type: "json_object" } }),
  messages: [
    { role: "system", content: "You are a document layout analyser. You reply with JSON and nothing else." },
    {
      role: "user",
      content: [
        { type: "text", text: instruction(languages) },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
        },
      ],
    },
  ],
});

const post = async (config: VlmConfig, body: unknown): Promise<Response> => {
  const timeout = Number(process.env.BOOKFORGE_VLM_TIMEOUT_MS ?? 180_000);
  try {
    return await fetch(`${config.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(config) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(
      `cannot reach ${config.url}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Set BOOKFORGE_VLM_URL to a running OpenAI-compatible server."
    );
  }
};

const content = (reply: unknown): string => {
  const choice = isRecord(reply) && Array.isArray(reply.choices) ? reply.choices[0] : null;
  const value = isRecord(choice) && isRecord(choice.message) ? choice.message.content : null;
  if (typeof value === "string") return value;
  // some servers answer with the parts array instead of a flat string
  if (Array.isArray(value))
    return value.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  return "";
};

export function vlmEngine(config: VlmConfig = vlmConfig(), cacheDir: string | null = VLM_CACHE_DIR): OcrEngine {
  // Everything that decides what comes back: the model, the server it runs on
  // — two of them answer differently for the same name — and `v1`, this
  // adapter's prompt and parsing contract. The API key is authorization, not
  // identity, and must not split the cache.
  const cache = ocrCache(cacheDir, `${VLM_ID}-v1\0${config.model}\0${config.url}`);
  return {
    name: `${config.model} via ${config.url}`,
    recognize(png, languages) {
      return cache(png, languages, async () => {
        // `response_format` is the cheapest way to get parseable output where
        // the server supports it; one that rejects the field gets the same
        // request without it rather than a failed page.
        let response = await post(config, request(png, languages, config, true));
        if (response.status === 400 || response.status === 422)
          response = await post(config, request(png, languages, config, false));
        if (!response.ok)
          throw new Error(
            `${config.model} at ${config.url} failed (HTTP ${response.status}): ${snippet(
              await response.text().catch(() => "")
            )}`
          );
        const reply: unknown = await response.json().catch(() => null);
        return vlmBlocks(content(reply), pngSize(png), `${config.model} at ${config.url}`);
      });
    },
  };
}

// The Studio lists models on every panel action, so reachability is probed at
// most once every few seconds instead of once per listing.
let probe: { url: string; at: number; ok: Promise<boolean> } | null = null;

const ping = async (config: VlmConfig): Promise<boolean> => {
  try {
    // any HTTP answer means a server is there; 401 or 404 is a configuration
    // problem the operator can see, not an absent endpoint
    await fetch(`${config.url}/models`, { headers: auth(config), signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
};

const reachable = (config: VlmConfig): Promise<boolean> => {
  const now = Date.now();
  if (!probe || probe.url !== config.url || now - probe.at > 5_000)
    probe = { url: config.url, at: now, ok: ping(config) };
  return probe.ok;
};

export const vlmProvider: ModelProvider = {
  info: {
    id: VLM_ID,
    name: "OpenAI-compatible VLM",
    version: "v1",
    description: "Any vision model behind /v1/chat/completions: Ollama, LM Studio, vLLM, or a hosted API.",
    capabilities: ["layout", "multilingual", "tables", "formulas"],
    runtime: "http",
    installLabel: "Check endpoint",
    firstRunNote: "Every selected page is sent to this endpoint as a PNG image.",
  },
  /** Nothing of ours is ever on disk, so "installed" means a server answered. */
  async status(): Promise<ModelStatus> {
    const endpoint = vlmEndpoint();
    const installed = await reachable(vlmConfig());
    return { installed, source: installed ? "external" : null, diskBytes: 0, endpoint };
  },
  async create() {
    const config = vlmConfig();
    if (!config.model) throw new Error("Set BOOKFORGE_VLM_MODEL to the vision model this endpoint serves.");
    return vlmEngine(config);
  },
  /** Installs nothing: it reports whether the configured endpoint answers. */
  async install() {
    const config = vlmConfig();
    if (!(await ping(config)))
      throw new Error(
        `No OpenAI-compatible server answered at ${config.url}. Start one (for example \`ollama serve\`), ` +
          "or set BOOKFORGE_VLM_URL, BOOKFORGE_VLM_MODEL and BOOKFORGE_VLM_API_KEY."
      );
    probe = null;
    const { local } = vlmEndpoint();
    return (
      `${config.url} answered; pages will be sent to "${config.model}".` +
      (local ? "" : " That endpoint is not on your machine: every page image leaves it.")
    );
  },
  /** Nothing on disk, nothing to delete. The Studio hides the action entirely. */
  async remove() {
    return "Nothing to remove: this provider only calls a configured endpoint. Point BOOKFORGE_VLM_URL elsewhere to change it.";
  },
};
