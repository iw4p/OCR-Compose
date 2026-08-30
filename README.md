# OCR Compose

**Make a real EPUB from a PDF — including scanned ones.**

[![CI](https://github.com/iw4p/OCR-Compose/actions/workflows/ci.yml/badge.svg)](https://github.com/iw4p/OCR-Compose/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

```sh
git clone https://github.com/iw4p/OCR-Compose.git
cd OCR-Compose
npm install
npm run studio          # then open the printed local URL
```

Drop a PDF, read one page to see the quality and learn how fast your machine
is, then convert and download the EPUB. Everything — the model, the weights,
the book — stays on your machine; nothing is ever uploaded.

"Real" means reflowable text with figures, tables, footnotes and
cross-references intact and correctly anchored — not a page-image container,
not a wall of undifferentiated paragraphs. Existing tools either reproduce the
PDF's fixed layout (useless on a 6" screen) or squeeze everything through
Markdown and lose exactly the things that make a book a book.

The full reasoning, evidence and roadmap live in [DESIGN.md](DESIGN.md). This
file is the short version: what works today and how the pieces fit.

## How it works

Everything revolves around one idea: a neutral **document contract** sits
between whatever we read (PDF, EPUB) and whatever we write (EPUB, later HTML
or DAISY). Front ends produce it, back ends consume it, and cleanup passes
transform it — nobody talks to anybody else directly.

```
   PDF (native)  ─┐                  ┌─► EPUB3
   PDF (scanned) ─┤►   book.json   ──┤
   EPUB ─────────┘    + assets/      └─► (later: HTML, DAISY, Markdown)
```

The contract is a folder: a human-readable `book.json` plus an `assets/`
directory for images. `book.json` holds one flat, ordered list of blocks for
the whole book — headings, paragraphs, quotes, images, tables, formulas,
lists — with footnotes in a separate map. Pages are metadata on blocks
(*"this paragraph came from pages 41–42, breaking at character 53"*), never
containers, because everything interesting in a book crosses page boundaries.

Because the JSON is readable, it doubles as an **editing format**: unpack an
EPUB, fix the three things that are wrong, validate, pack. No Sigil, no XML.

Inline formatting uses a small closed dialect inside text strings — `*em*`,
`**strong**`, `$TeX math$`, `[^footnote-id]`, `[link text](#anchor-id)` — and
explicit fields for everything else (captions, attributions, languages, page
provenance). Every construct is validated; a typo is an error, never silent
corruption.

Two fidelity rules keep the door open for hard problems without blocking on
them: a table with parsed `rows` becomes a real `<table>`, one without becomes
an image; a formula with `tex` becomes MathML (the TeX rides along losslessly
inside it), one without becomes an image. When better recognizers land, output
improves and no schema or back-end code changes.

## What works today

The "back half" — everything from the contract to EPUB and back:

- **`contract`** ([src/contract.ts](src/contract.ts)) — the schema and
  validator. Catches malformed shapes, unknown fields, dangling
  cross-references, missing footnotes, duplicate ids, dialect syntax errors
  (with the exact path), and annotation offsets that drifted out of sync.
- **inline dialect** ([src/inline.ts](src/inline.ts)) — parser and renderer
  for the text markup, round-trip exact: `render(parse(s)) === s`.
- **`epub3` writer** ([src/epub/write.ts](src/epub/write.ts)) — contract →
  EPUB3: navigation document, semantic footnotes (`epub:type="noteref"` /
  `"footnote"`), figures with captions, MathML, and a page-list wired to
  pagebreak markers — including markers placed mid-paragraph at the exact
  character where the page turned.
- **`epub-read`** ([src/epub/read.ts](src/epub/read.ts)) — the inverse:
  EPUB → contract, reconstructing blocks, dialect text, footnotes, and page
  provenance from the markup.

A book run through write → read comes back **identical**, byte for byte of
JSON — that round-trip is the core of the test suite.

And the **PDF front end** ([src/pdf/](src/pdf/)), covering all three kinds of
PDF:

- **`textlayer`** — the per-page routing verdict (`native` / `scanned` /
  `no-text`) from image coverage and a language-agnostic garble score. A
  double-layer PDF is `scanned`: its hidden OCR text is never trusted.
- **`extract`** — text runs with real font names (italics are read from the
  font name, never guessed from pixels), images, bookmarks.
- **passes** — running header/footer removal with printed-page capture,
  line-to-paragraph unwrapping with evidence-based dehyphenation, cross-page
  merging (recording the exact break offset for the EPUB page-list), drop-cap
  absorption, font-size outline detection.
- **`ocr-adapter`** — for scanned books: a document model's own layout
  analysis. Its semantic paragraphs, headings, tables and formulas map
  directly into contract blocks; they are never degraded into synthetic PDF
  lines. Illustrations are cropped out of the page render and written as
  assets, with adjacent captions bound to them, and tables are parsed into
  real `rows`. Results are cached, so re-runs are instant. The model is
  **PaddleOCR-VL 1.6**: its VLM reads formulas and messy tables as well as
  ordinary prose.

Not built yet: math structure recognition and tables too irregular to parse
(`colspan`/`rowspan`) — both degrade to images by design — TOC cross-checking
for books whose chapter titles look like running heads, and figure extraction
beyond embedded images on the native path.

## Using it

```sh
npm install
npm test
```

Node 22 or newer. The core library, the CLI and the EPUB path need nothing
else — no Python, no models, no GPU. Only scanned PDFs do.

### OCR Compose Studio

The local Studio is the whole PDF → EPUB workflow in one page:

```sh
npm run studio
```

Open the printed local URL, then:

1. Install PaddleOCR-VL, if it is not already there. The card states the
   download size before you commit to it and streams the installer's output.
2. Drop a PDF. Every page is classified as native text, scanned or blank, and
   you pick the pages that belong in the output.
3. Read one page for real. You see the recognized regions and the blocks they
   become, and the page's measured duration turns into a time estimate for the
   whole selection on *this* machine.
4. Convert, watching real per-page progress, then download the EPUB or
   `book.json`.

The app runs locally because model environments, model weights and source
books should remain on the user's machine. Nothing is written outside
`.ocr-compose-models/` (the runtime) and `.ocr-compose-cache/` (recognized pages);
the PDF itself is held in memory for the session only.

The CLI (via `npx tsx src/cli.ts …` or `npm run build` then
`node dist/cli.js …`):

| Command | Does |
|---|---|
| `ocr-compose pdf in.pdf book/ [--title T] [--author A] [--lang L] [--pages 1,3-5] [--ocr]` | PDF → editable `book.json` + `assets/` |
| `ocr-compose unpack in.epub book/` | EPUB → editable `book.json` + `assets/` |
| `ocr-compose validate book/` | check a book folder, print issues with paths |
| `ocr-compose pack book/ out.epub` | book folder → EPUB (refuses invalid input) |
| `ocr-compose studio [--port 4173]` | launch the local Studio: drop → test → convert |

### The OCR model

[PaddleOCR-VL 1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6) runs
entirely on your machine; nothing is ever uploaded. The Studio installs it into
`.ocr-compose-models/paddleocr-vl-1.6/` for you — roughly 1.2 GB of Python
runtime, plus about 2 GB of weights fetched on the first page you read. The
commands below are the manual equivalent; its dependencies are pinned in
[tools/paddle/pyproject.toml](tools/paddle/pyproject.toml) (Python 3.9–3.13,
PaddlePaddle 3.2.1, `paddleocr[doc-parser]` 3.6.0+):

```sh
uv venv --python 3.13 .venv-paddleocr
uv pip install --python .venv-paddleocr/bin/python -r tools/paddle/pyproject.toml
export OCR_COMPOSE_PADDLEOCR_PYTHON="$PWD/.venv-paddleocr/bin/python"
```

On Apple Silicon the official local route uses `cpu`; set
`OCR_COMPOSE_PADDLEOCR_DEVICE=cpu`. GPU hosts can select a Paddle device such as
`gpu:0`. Direct Apple CPU inference is very slow. Paddle's supported accelerated
Apple path keeps layout analysis local and serves the VLM with MLX-VLM (the
`mlx` extra):

```sh
uv pip install --python .venv-paddleocr/bin/python -r tools/paddle/pyproject.toml --extra mlx
.venv-paddleocr/bin/mlx_vlm.server --port 8111
export OCR_COMPOSE_PADDLEOCR_VL_BACKEND=mlx-vlm-server
export OCR_COMPOSE_PADDLEOCR_VL_SERVER_URL=http://localhost:8111/
export OCR_COMPOSE_PADDLEOCR_VL_MODEL_NAME=PaddlePaddle/PaddleOCR-VL-1.6
```

The typical PDF→EPUB flow is `ocr-compose pdf` … inspect/fix `book.json` …
`ocr-compose pack`.

## Repo layout

```
DESIGN.md          the why: evidence, architecture, roadmap
tools/             the persistent OCR bridge: ocr-paddle.py and its pinned
                   Python environment
src/
  contract.ts      schema, validator, block walker
  inline.ts        the inline dialect: parse + render
  fixtures.ts      the design doc's own example book, used as a permanent fixture
  epub/write.ts    contract → EPUB3
  epub/read.ts     EPUB → contract
  pdf/textlayer.ts per-page verdict: which pipeline a page needs
  pdf/extract.ts   mupdf wrapper: runs, lines, images, bookmarks
  pdf/passes.ts    classify / unwrap / outline
  pdf/ocr.ts       OCR adapter interface, block mapper, the Paddle engine
  pdf/pdf.ts       the front-end orchestrator
  models/          model install, removal and warm-engine lifecycle
  studio/          the local Studio server (Fastify)
    server.ts      app assembly: plugins, error shape, static UI
    routes/        one file per group of endpoints
    documents.ts   the uploaded PDFs this process is holding
    schemas.ts     every request shape the API accepts
    stream.ts      the progress-event protocol long jobs answer with
  cli.ts           pdf / unpack / pack / validate
  *.test.ts        the tests live next to what they test
studio/            the local drop → test → convert UI
```
