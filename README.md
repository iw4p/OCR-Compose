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

![The Studio converting three pages of a two-column arXiv paper in paper mode:
the pages are classified, the model reads each page live — its regions drawn
over the page beside the blocks they become — and the finished book opens for
review and editing](docs/studio-live.gif)

*Three pages of a two-column arXiv paper, live: drop, paper mode, watch each
page being read, then review the book and download the EPUB.*

![The Studio reading one scanned page of Alice's Adventures in Wonderland: the
regions the model found drawn over the page, the blocks they become, and the
measured cost per page](docs/studio.png)

*One page of a scanned* Alice *— the regions the model found, the blocks they
become, and what the whole selection will cost on this machine.*

"Real" means reflowable text with figures, tables, footnotes and
cross-references intact and correctly anchored — not a page-image container,
not a wall of undifferentiated paragraphs. Existing tools either reproduce the
PDF's fixed layout (useless on a 6" screen) or squeeze everything through
Markdown and lose exactly the things that make a book a book.

The full reasoning, evidence and roadmap live in
[docs/DESIGN.md](docs/DESIGN.md). This file is the short version.

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
an image; a formula with `tex` becomes typeset MathML — real fractions and
superscripts that reflow and scale with the reader's font, with the TeX riding
along losslessly inside it — one without becomes an image. When better
recognizers land, output improves and no schema or back-end code changes.

Not built yet: tables too irregular to parse (`colspan`/`rowspan`) — these
degrade to images by design — TOC cross-checking for books whose chapter
titles look like running heads, and figure extraction beyond embedded images
on the native path.

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
4. Convert, watching each page appear as the model reads it. For academic
   papers, switch on **paper mode**: the model reads every page — so
   multi-column layouts come out in reading order, formulas become real math
   (MathML, TeX kept inside), and tables become tables. The CLI equivalent is
   `--ocr-all`.
5. Review the finished book in place — scroll it, fix a block's text, move or
   remove one; every change is validated and the EPUB re-packs — then
   download the EPUB or `book.json`. Both can come back later: drop an EPUB
   or a `book.json` on the Studio and it opens straight in Review.

The app runs locally because model environments, model weights and source
books should remain on the user's machine. Nothing is written outside
`.ocr-compose-models/` (the runtime) and `.ocr-compose-cache/` (recognized pages);
the PDF itself is held in memory for the session only.

The CLI (via `npx tsx src/cli.ts …` or `npm run build` then
`node dist/cli.js …`):

| Command | Does |
|---|---|
| `ocr-compose pdf in.pdf book/ [--title T] [--author A] [--lang L] [--pages 1,3-5] [--ocr] [--ocr-all]` | PDF → editable `book.json` + `assets/` |
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
Apple path keeps layout analysis local and serves the VLM with MLX-VLM — in the
Studio this is one click: the model card offers **fast mode** on Apple Silicon,
installs the `mlx` extra if needed, and starts and stops the MLX server itself
(measured here: about 8× the CPU rate; very rarely the fast path repeats a
phrase, so the CPU path stays the reference). The commands below are the manual
CLI equivalent:

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
docs/DESIGN.md     the why: evidence, architecture, roadmap
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
