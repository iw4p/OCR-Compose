# OCR Compose Studio architecture

The Studio is one page that does one job: turn a PDF into an EPUB, with enough
real numbers on screen that nobody has to guess how long it will take or how
much disk it will cost.

It is a client of OCR Compose. It contains no second conversion pipeline.

## The flow

![The whole Studio: the model card, a scanned Alice with its page map, one page
read for real, and the convert step carrying the measured estimate](studio-full.png)

1. **Model.** PaddleOCR-VL, installed into an isolated venv under
   `.ocr-compose-models/`. Before installing, the card states the download size;
   during installation it streams the installer's own output; afterwards it
   shows what is actually on disk, whether weights are cached, whether the model
   is resident in memory, and the CPU and RAM it will run on.

   On Apple Silicon the card also offers **fast mode**: one click installs
   `mlx-vlm` (into our managed venv only — an operator's own environment gets
   the command to run instead) and from then on the Studio starts an MLX
   server alongside the engine and serves the VLM step on the machine's GPU,
   stopping it when the engine unloads. PaddlePaddle has no Apple-GPU backend,
   so this is the difference between ~104 s and ~13 s a page here. If the
   server cannot come up, conversion falls back to the CPU rather than
   failing. The state lives in one marker file, `.ocr-compose-models/fast-mode`
   (see `src/models/fastmode.ts`).
2. **File.** A dropped PDF is classified page by page — native text, scanned or
   blank — and the whole book is shown as one map you select pages in. An EPUB
   or a `book.json` can be dropped too: it skips conversion and goes straight
   to Review, so a book made earlier can come back for fixing. (A bare
   `book.json` referencing images it cannot carry is refused with the way out
   — upload the EPUB, which carries them.)
3. **Test.** One page is recognized for real, cache bypassed. You see the
   regions the model found drawn over the page, the contract blocks they become,
   and the measured duration.
4. **Convert.** The measured per-page cost projects onto the selection, and the
   conversion reports true per-page progress while it runs. Once the machine
   starts finishing pages, the remaining time is recomputed from its own rate
   rather than the projection. Then: EPUB or `book.json`.

   **Paper mode** sends native-text pages through the model too. The native
   path reads a page's text in raw stream order, which interleaves the columns
   of a two-column layout; the model reads the page like a person instead, and
   brings formulas (TeX → MathML) and tables (parsed rows) with it. It is the
   right choice for academic papers and the wrong one for novels, which is why
   it is a toggle and not a heuristic.

5. **Review.** The finished book, scrollable, rendered from the contract —
   dialect emphasis as emphasis, images, tables, TeX. Hovering a block offers
   move, remove, and (for anything that carries one text) edit-as-dialect.
   Every change goes through the same validation `pack` refuses on — a bad
   edit is an error naming the block, never a corrupt EPUB — and re-packs
   immediately, so the download links always serve what the card shows.
   Heavier surgery still belongs in `book.json` itself; the card is for the
   three things a conversion got wrong, not for authoring.

## Time estimates

Every estimate is measured on the machine it runs on — there is no table of
assumed speeds. The test run times recognition alone (`fresh: true` bypasses the
page cache, and the clock starts after the engine is warm, because loading
weights is a one-time cost, not a per-page one). Native pages are charged a flat
120 ms; scanned pages — and in paper mode every page — are charged the measured
figure. Until a page has been timed, a selection needing the model reports no
estimate at all rather than a made-up one.

## API

Fastify, in `src/studio/`. Routing, parameter and body validation, error status
codes and static file serving are the framework's; what is ours is the four
files beside it — `routes/` (the endpoints), `documents.ts` (the PDFs this
process is holding), `schemas.ts` (every shape the API accepts, in one place)
and `stream.ts` (the progress protocol).

| route | what it does |
|---|---|
| `GET /api/status` | model state plus the host's CPU, cores and RAM |
| `POST /api/model/install` | installs the runtime, streaming log lines as events |
| `POST /api/model/unload` \| `/remove` | free memory; delete the managed runtime |
| `POST /api/documents` | raw PDF body in, page verdicts out |
| `GET /api/documents/:id/pages/:page.png` | a rendered page |
| `POST /api/documents/:id/test` | recognize one page, timed, uncached |
| `POST /api/documents/:id/convert` | convert, streaming stages, per-page progress and each page's blocks |
| `GET` \| `PUT /api/documents/:id/book` | the book for review; a validated edit that re-packs the EPUB |
| `GET /api/documents/:id/assets/:file` | an image the conversion produced |
| `POST /api/model/fast/enable` \| `/disable` | Apple-GPU fast mode, streaming the install |
| `GET /api/documents/:id/epub` \| `/book.json` | the finished output |

Every failure answers with the same shape, `{ "error": "..." }`, at the status it
deserves: 400 for a malformed request, 404 for a document this process no longer
holds, 413 for an oversized upload, 500 for a genuine surprise.

### Long jobs answer with events, not a response

Installing and converting take minutes, so they answer with a stream of JSON
events instead of one response at the end. That is what makes honest progress
possible, and it comes with one rule worth knowing before editing those routes:

**a streaming route must validate inside its own stream.** Fastify's schema
validation runs *before* the handler and answers a bad request with a status
code — which a client that is reading events never sees, so the failure vanishes
and the UI just sits there. `POST /convert` therefore declares no schema and
calls `parse()` from `schemas.ts` inside `stream()`, where a rejection becomes an
`{ "type": "error" }` event like any other failure. `src/studio/server.test.ts`
holds that behaviour down.

A document lives in server memory, and only the three most recent survive — one
holds a whole PDF and its EPUB. Nothing about it is written to disk except
recognized pages in `.ocr-compose-cache/`.

## Ownership boundaries

**TypeScript core:** page classification and rendering, page selection, model
install/lifecycle, timing, OCR block normalization, the Book contract, EPUB
output, the HTTP API and the UI.

**Python adapter** (`tools/ocr-paddle.py`): model loading, device configuration,
inference, and model-specific output parsing, returned as normalized positioned
blocks over the JSONL protocol.

Python never creates EPUB structures. The UI never interprets a model's
internals.

## Lifecycle: get it, run it, stop it, remove it

`src/models/registry.ts` owns model lifetime.

- `withModel(use)` runs `use` against a warm engine, loading one only if none is
  resident. Engines are refcounted, so an engine is never closed while a request
  is still using it, and a call that throws evicts its engine so a crashed helper
  cannot poison the next request.
- Idle engines unload themselves after `OCR_COMPOSE_MODEL_IDLE_MS` (default five
  minutes; `0` disables keep-alive). A test page and the conversion that follows
  it therefore load the weights once, not twice.
- `unloadModel()` frees memory immediately; an in-flight request finishes first.
- `removeModel()` unloads, then deletes the runtime from disk.

## Disk safety

Installation and the model weights are separate concerns:

- The **runtime** lives in `.ocr-compose-models/paddleocr-vl-1.6/`, is created by
  `installModel()`, measured by `modelStatus()`, and is the *only* tree
  `removeModel()` may delete. `managedModelDir(id)` resolves that path and throws
  unless the result is strictly inside `.ocr-compose-models/`, so no id, traversal
  or symlink can escape it.
- The **weights** are downloaded by the model itself on first inference, into the
  shared PaddleX cache. They are outside OCR Compose's control and are never
  deleted; `removeModel()` says so in its message. Their size is reported by
  measuring that cache, not by guessing.
- A runtime found through `OCR_COMPOSE_PADDLEOCR_PYTHON` or a hand-made
  `.venv-paddleocr/` reports `source: "external"`. External runtimes are usable
  but never removable, and the UI hides the uninstall action for them.

The installer builds an isolated venv from `OCR_COMPOSE_PYTHON` (default
`python3`) and refuses a base interpreter that is not Python 3.

## Local state

- `.ocr-compose-models/<id>/` — managed model runtimes, the only tree the Studio
  ever deletes.
- `.ocr-compose-cache/` — disposable recognition results, keyed by the page image,
  the languages, and the adapter's own output contract, so a page tested in the
  Studio is not recognized again during conversion.

Both are ignored by version control.

## Where pages go

Nowhere. The model runs on this machine, so the book never leaves it: no
telemetry, no account, no hosted backend. The source file stays in memory, and
rendered pages, `book.json` and the EPUB stay on this machine.

The only traffic OCR Compose originates is downloading the model: pip fetching
packages from PyPI, and the first inference fetching the weights. Both are
downloads. Neither carries any part of a book.
