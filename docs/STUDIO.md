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

Every provider caches its comparison results through the same helper (`ocrCache`), so a compared page is reused during conversion instead of being recognized twice. An entry is addressed by the full identity of whatever produced it, the page image, and the languages — the model, its version, and the adapter's own output contract — so a result one provider wrote is never served to another. Each provider keeps its own directory under `.bookforge-cache/`, and deleting one leaves the others alone.

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

Python never creates EPUB structures. The UI never interprets a model's internals.

## The two models

| | OnnxTR 0.9 (default) | PaddleOCR-VL 1.6 |
|---|---|---|
| Runtime | `onnxtr[cpu]`: onnxruntime + opencv, no PyTorch | PaddlePaddle + `paddleocr[doc-parser]` |
| Python | 3.11+ | 3.9–3.13 |
| Weights | ~275 MB | ~1 GB, downloaded on first use |
| Speed | ~0.2–0.6 s a page on a desktop CPU | slow on CPU; needs MLX or a GPU to be pleasant |
| Reads | layout, reading order, tables | layout, tables, formulas, and a VLM that transcribes them |
| Runs on | almost anything: onnxruntime dispatches SIMD at runtime | needs AVX, and realistically an accelerator |

OnnxTR is first because it installs with one pip command and finishes a book on a laptop. PaddleOCR-VL stays as the higher-accuracy tier: its VLM reads formulas and messy tables that OnnxTR cannot.

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
};
```

`OcrEngine` returns ordered normalized blocks with text, a semantic label, and a normalized bounding box. A provider owns how it loads and runs its model, but it must honor that same result contract. The Studio automatically lists and compares every registered provider.

A runtime Bookforge installed itself reports `source: "managed"` and its size on disk; one the operator provided reports `source: "external"` and is never removable. The Studio only ever offers removal for `source: "managed"`.

### Label normalization

Model-specific labels are normalized before they enter `ocrBlocksToBookBlocks`. Source-specific interpretation happens first; shared semantic processing happens second; the strict Book contract remains the final boundary.

OnnxTR is the worked example. It reports DocLayNet's eleven classes, and two of them are traps: the mapper matches furniture with `/header|footer|…/`, so a raw `Section-header` would be hidden as a running head, and `Picture` matches nothing at all, so it would be dropped as an empty block. `onnxtrLabel` (`src/pdf/ocr.ts`) maps every class explicitly:

| OnnxTR class | mapper label | contract block |
|---|---|---|
| `Title` | `doc_title` | `heading` level 1 |
| `Section-header` | `paragraph_title` | `heading` level 2 |
| `Text` | `text` | `text` |
| `List-item` | `list` | one `list`, consecutive items merged |
| `Table` | `table` | `table` with parsed `rows`, or `role: "table-source"` |
| `Caption` | `caption` | `role: "caption"`, bound to a touching figure |
| `Footnote` | `footnote` | `role: "footnote-source"` |
| `Page-header` | `header` / `number` | `role: "running-header"` / `"page-number"` |
| `Page-footer` | `footer` / `number` | `role: "running-footer"` / `"page-number"` |
| `Picture` | `image` | `image`, cropped from the page render |
| `Formula` | `image` | `image`, cropped from the page render |

A running head that is nothing but a numeral becomes `number`, so it is demoted as a page number rather than a title. `Formula` becomes a picture on purpose: OnnxTR recognizes text, not math, so its characters would be a plausible-looking lie in a `tex` field — the pixels are the only faithful record (§3.3). Anything unrecognized becomes prose, never an invented heading.

Tables take the same route as Paddle's rather than a second one: `tools/ocr-onnxtr.py` reports the cell grid, `onnxtrTableHtml` serializes it to `<table>` markup, and the existing `htmlTable` parser turns that into `rows`. A merged cell keeps its `colspan`/`rowspan`, so the parser refuses the grid and the block degrades to `table-source` instead of being silently reshaped. OnnxTR removes table words from its text blocks, so nothing is counted twice.

Geometry needs no conversion at all: OnnxTR's `geometry` is already `((xmin,ymin),(xmax,ymax))` relative to the page with a top-left origin, so the provider clamps it to the page and subtracts. Nothing is rescaled and there is no resize grid to get wrong.

### Known limitation: OnnxTR flattens typography

Neither the default recognizer nor the multilingual one has curly quotes, em or en dashes, or ellipses in its vocabulary (`" " ' ' — – …`). Books are full of them, so expect ASCII substitutes and, where the recognizer guesses, visible junk: `"` may come back as `C6`, `66` or `33`. This is a property of the weights, not a bug in the adapter, and it is deliberately not patched here — a separate `typography` pass belongs after recognition, where it can see whole sentences. PaddleOCR-VL's VLM does not have this problem.

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
- The **weights** are downloaded by the model itself on first inference — into `ONNXTR_CACHE_DIR` for OnnxTR, the shared PaddleX/HuggingFace cache for Paddle. They are outside Bookforge's control and are never deleted; `remove()` says so in its message.
- A runtime found through `BOOKFORGE_ONNXTR_PYTHON`, `BOOKFORGE_PADDLEOCR_PYTHON` or a hand-made `.venv-paddleocr/` reports `source: "external"`. External runtimes are usable but never removable, and the Studio hides the remove action for them.

Both installers build an isolated venv under `.bookforge-models/<id>/venv/` from `BOOKFORGE_PYTHON` (default `python3`), and refuse a base interpreter too old for the model — OnnxTR needs 3.11. On Intel Macs the OnnxTR installer pins `onnxruntime==1.23.2`, because onnxruntime publishes arm64-only macOS wheels from 1.24.1 onwards. The helper asks for `CPUExecutionProvider` explicitly: it runs every one of these graphs, where CoreML miscompiles `parseq`.

## Local state

- `.bookforge-models/<id>/` contains managed isolated model runtimes, and is the only tree the Studio ever deletes.
- `.bookforge-cache/` contains disposable inference results.
- `.bookforge-studio/` contains disposable uploaded working copies and session state.

All three directories are ignored.

## Where pages go

Nowhere. Every provider runs its model on this machine, so the book never leaves it: no telemetry, no account, no hosted backend, and no provider that sends a page image anywhere. The source file, the rendered pages, `book.json` and the EPUB all stay on disk under `.bookforge-studio/`, `.bookforge-cache/` and `.bookforge-models/`.

The only traffic Bookforge ever originates is downloading a model: `install()` fetches Python packages from PyPI, and the first inference downloads the model's own weights. Both are downloads. Neither carries any part of a book.

Keeping that true is a rule for new providers, not an accident of the current set: a provider that would send page images to a third party does not belong in this registry.

## Next provider checklist

1. Add an adapter: a Python helper on the persistent JSONL protocol, like `tools/ocr-paddle.py`.
2. Normalize its labels and coordinates to `OcrBlock`.
3. Add one provider object to the registry, including detection, isolated installation, disk reporting and removal.
4. Add mapper fixtures for headings, paragraphs, furniture, lists, tables and formulas.
5. Compare the provider on the same fixture page as Paddle.
6. Verify a selected result produces a valid Book and round-trip EPUB.

