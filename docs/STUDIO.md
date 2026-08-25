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

The comparison result is cached by the existing OCR adapter and reused during conversion when its model, image, and configuration identity match.

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
};
```

`OcrEngine` returns ordered normalized blocks with text, a semantic label, and a normalized bounding box. A future provider may use Python, a local HTTP process, or a remote service, but it must honor that same result contract. A provider with nothing on disk — a remote or OpenAI-compatible one — reports `source: null` and `diskBytes: 0`, and its `install`/`remove` are no-ops. The Studio automatically lists and compares every registered provider.

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

All three directories are ignored. Original books are never sent to a hosted service by the Studio.

## Next provider checklist

1. Add a Python adapter that implements the persistent JSONL request/reply protocol.
2. Normalize its labels and coordinates to `OcrBlock`.
3. Add one provider object to the registry, including detection, isolated installation, disk reporting and removal.
4. Add mapper fixtures for headings, paragraphs, furniture, lists, tables and formulas.
5. Compare the provider on the same fixture page as Paddle.
6. Verify a selected result produces a valid Book and round-trip EPUB.

