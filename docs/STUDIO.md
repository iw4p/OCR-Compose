# Bookforge Studio architecture

Bookforge Studio is a local-first workbench for two overlapping jobs:

- OCR operators compare document models before paying the cost of a full run.
- EPUB editors correct the semantic Book contract instead of editing generated HTML.

The UI is a client of Bookforge. It does not contain a second conversion pipeline.

## Workflow

1. Upload a PDF or EPUB.
2. Inspect the document and classify PDF pages as native, scanned, or blank.
3. Select output pages and one representative comparison page.
4. Render that page once and send the same PNG to every selected model.
5. Run models sequentially by default so ordinary machines do not hold several models in memory.
6. Show elapsed time, positioned regions, and semantic contract blocks for every result.
7. Keep the selected model loaded while converting the chosen pages, and for a short idle window afterwards.
8. Edit, reorder, insert, remove, and validate Book blocks.
9. Export `book.json` or a reflowable EPUB.

Every provider caches its comparison results through the same helper (`ocrCache`), so a compared page is reused during conversion instead of being recognized — or paid for — twice. An entry is addressed by the full identity of whatever produced it, the page image, and the languages: PaddleOCR-VL by its model version and the adapter's output contract, the OpenAI-compatible provider additionally by its model name and endpoint URL, so two servers or two models never share a result. Each provider keeps its own directory under `.bookforge-cache/`, and deleting one leaves the others alone.

## Ownership boundaries

### TypeScript core

- input inspection and page rendering
- page selection and routing
- model registry and lifecycle orchestration
- comparison timing and memory-safe sequencing
- OCR block normalization
- Book contract validation
- asset handling and EPUB output
- the local HTTP API and browser UI

### Python model adapter

- model installation dependencies
- device/backend configuration
- model loading and inference
- model-specific output parsing
- normalized positioned blocks over the JSONL protocol

Python never creates EPUB structures. The UI never interprets Paddle internals.

## Provider extension point

A provider is one object in `src/models/registry.ts`, added to the registry with `registerProvider`:

```ts
type ModelProvider = {
  info: Omit<ModelInfo, keyof ModelStatus | "loaded">;
  status(): Promise<ModelStatus>;   // installed, where it lives, bytes on disk
  create(): Promise<OcrEngine>;     // load; the registry keeps it warm
  install(): Promise<string>;       // put the runtime on disk
  remove(): Promise<string>;        // delete what install() put there
};

type ModelStatus = {
  installed: boolean;
  source: "managed" | "external" | null;
  diskBytes: number;
  endpoint?: { url: string; local: boolean };  // providers that call out instead of installing
};
```

`OcrEngine` returns ordered normalized blocks with text, a semantic label, and a normalized bounding box. A provider may use Python, a local HTTP process, or a remote service, but it must honor that same result contract. The Studio automatically lists and compares every registered provider.

A provider with nothing on disk reports `diskBytes: 0`, `source: "external"` when its endpoint answers and `null` when it does not, and sets `endpoint` so the Studio can show where pages go. For such a provider `install()` installs nothing — it probes the endpoint and reports what it found — and `remove()` deletes nothing; the Studio only ever offers removal for `source: "managed"`.

### OpenAI-compatible VLM provider

`src/models/vlm.ts` is one adapter for the `/v1/chat/completions` vision API, which covers Ollama, LM Studio, vLLM, OpenRouter and hosted APIs without a line of code per model. It is configured entirely by environment, in the same spirit as `BOOKFORGE_PADDLEOCR_*`:

| Variable | Default | Meaning |
|---|---|---|
| `BOOKFORGE_VLM_URL` | `http://localhost:11434/v1` | OpenAI-compatible base URL |
| `BOOKFORGE_VLM_MODEL` | `qwen2.5vl` | model name the endpoint serves |
| `BOOKFORGE_VLM_API_KEY` | *(none)* | sent as `Authorization: Bearer …` |
| `BOOKFORGE_VLM_TIMEOUT_MS` | `180000` | per-page request timeout |

The page PNG is sent as a base64 `image_url` data URI with a prompt asking for labelled layout blocks and normalized corner boxes, requested as `response_format: {"type": "json_object"}` and retried once without that field for servers that reject it.

A general vision model is not a document parser, so the reply is treated as untrusted text:

- JSON is recovered from the whole reply, from the outermost array or object inside prose or code fences, or from one object per line.
- Labels are collapsed to the vocabulary `ocrBlocksToBookBlocks` already switches on; an unrecognized label becomes prose rather than an invented heading.
- Boxes are accepted as corner arrays, point pairs, or `x`/`y`/`w`/`h` objects, and rescaled from unit fractions, percentages, the 0–1000 grid many VLMs are trained on, or page pixels (read from the PNG header) — whichever scale fits the page most tightly.
- A block whose box is missing or nonsensical never becomes a zero-size *region*: text keeps its place in reading order with an inert empty box, and a picture nobody can locate is dropped rather than cropped from invented coordinates.
- Individually malformed entries are skipped; only a reply with no structure at all fails the page, and it fails naming the model, the endpoint, and the start of what came back.

Model-specific labels are normalized before they enter `ocrBlocksToBookBlocks`. Source-specific interpretation happens first; shared semantic processing happens second; the strict Book contract remains the final boundary.

### Lifecycle: get it, run it, stop it, remove it

The registry owns model lifetime, so a provider never manages its own process pool.

- `withModel(id, use)` runs `use` against a warm engine, loading one only if none is resident. Engines are refcounted, so an engine is never closed while a request is still using it, and a call that throws evicts its engine so a crashed helper cannot poison the next request.
- Idle engines unload themselves after `BOOKFORGE_MODEL_IDLE_MS` (default five minutes; `0` disables keep-alive). A comparison and the conversion that follows it therefore load model weights once instead of once per click.
- `unloadModel(id)` frees memory immediately; an in-flight request finishes first.
- `removeModel(id)` unloads, then deletes the runtime from disk. Destructive, so the Studio requires an explicit confirmation.

Comparison still runs models one at a time, so ordinary machines hold at most one model in memory.

### Disk safety

Installation and removal are separate concerns from the model weights:

- The **runtime** lives in `.bookforge-models/<id>/`, is created by `install()`, measured by `status()`, and is the *only* tree `remove()` may delete. `managedModelDir(id)` resolves that path and throws unless the result is strictly inside `.bookforge-models/`, so no id, traversal or symlink can escape it.
- The **weights** are downloaded by the model itself into the shared PaddleX/HuggingFace cache on first inference. They are outside Bookforge's control and are never deleted; `remove()` says so in its message.
- A runtime found through `BOOKFORGE_PADDLEOCR_PYTHON` or a hand-made `.venv-paddleocr/` reports `source: "external"`. External runtimes are usable but never removable, and the Studio hides the remove action for them.

## Local state

- `.bookforge-models/<id>/` contains managed isolated model runtimes, and is the only tree the Studio ever deletes.
- `.bookforge-cache/` contains disposable inference results.
- `.bookforge-studio/` contains disposable uploaded working copies and session state.

All three directories are ignored.

## Where pages go

The Studio itself never uploads anything: it has no telemetry, no account, and no hosted backend. Every model it can run is one the operator configured, and only two kinds exist:

- **Local providers** — PaddleOCR-VL, or an OpenAI-compatible endpoint on loopback, a `.local` name, or a private LAN address. Nothing leaves the machine or its network.
- **Remote endpoints** — an OpenAI-compatible provider pointed at a hosted API. Then the rendered page images of every page you compare or convert are uploaded to that third party, under their terms and retention policy. Nothing else is: the source file, `book.json` and the EPUB stay local.

That distinction is not left to the operator's memory. `ModelStatus.endpoint` reports the URL and whether it is local; the model card shows a `local endpoint` or `remote endpoint` chip, prints the URL, and a remote endpoint carries a standing warning naming the host that receives the pages. `install()` — "Check endpoint" — repeats it in its result. The default `BOOKFORGE_VLM_URL` is a local Ollama, so the zero-config case is local.

## Next provider checklist

1. Add an adapter: a Python helper on the persistent JSONL protocol, or an HTTP client like `src/models/vlm.ts`.
2. Normalize its labels and coordinates to `OcrBlock`.
3. Add one provider object to the registry, including detection, isolated installation, disk reporting and removal.
4. Add mapper fixtures for headings, paragraphs, furniture, lists, tables and formulas.
5. Compare the provider on the same fixture page as Paddle.
6. Verify a selected result produces a valid Book and round-trip EPUB.

