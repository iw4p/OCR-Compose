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
7. Keep the selected model loaded while converting the chosen pages.
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

A provider is one object in `src/models/registry.ts`:

```ts
type ModelProvider = {
  info: Omit<ModelInfo, "installed">;
  installed(): Promise<boolean>;
  create(): Promise<OcrEngine>;
  install(): Promise<string>;
};
```

`OcrEngine` returns ordered normalized blocks with text, a semantic label, and a normalized bounding box. A future provider may use Python, a local HTTP process, or a remote service, but it must honor that same result contract. The Studio automatically lists and compares every registered provider.

Model-specific labels are normalized before they enter `ocrBlocksToBookBlocks`. Source-specific interpretation happens first; shared semantic processing happens second; the strict Book contract remains the final boundary.

## Local state

- `.bookforge-models/` contains managed isolated model runtimes.
- `.bookforge-cache/` contains disposable inference results.
- `.bookforge-studio/` contains disposable uploaded working copies and session state.

All three directories are ignored. Original books are never sent to a hosted service by the Studio.

## Next provider checklist

1. Add a Python adapter that implements the persistent JSONL request/reply protocol.
2. Normalize its labels and coordinates to `OcrBlock`.
3. Add one provider object to the registry, including detection and isolated installation.
4. Add mapper fixtures for headings, paragraphs, furniture, lists, tables and formulas.
5. Compare the provider on the same fixture page as Paddle.
6. Verify a selected result produces a valid Book and round-trip EPUB.

