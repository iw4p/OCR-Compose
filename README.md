# Bookforge

**Make a real EPUB from a PDF.**

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
- **`ocr-adapter`** — for scanned books: the complete PaddleOCR-VL 1.6
  document pipeline (layout analysis + VLM). Its semantic paragraphs,
  headings, tables and formulas map directly into contract blocks; they are
  never degraded into synthetic PDF lines. Results are cached, so re-runs are
  instant.

Not built yet: table/math structure recognition (they degrade to images, by
design), TOC cross-checking for books whose chapter titles look like running
heads, and figure extraction from scanned pages.

## Using it

```
npm install
npm test
```

### Bookforge Studio

The local Studio is the visual workflow for OCR operators and EPUB editors:

```sh
npm run studio
```

Open the printed local URL, then:

1. Drop a PDF or EPUB.
2. Select the pages that belong in the output.
3. Run one representative page through every installed OCR model.
4. Compare timing, positioned regions and semantic contract blocks.
5. Choose a model and convert the selected pages.
6. Reorder, add, remove and edit blocks; validate; export JSON or EPUB.

The app runs locally because model environments, model weights and source
books should remain on the user's machine. Uploaded working copies live under
`.bookforge-studio/`, which is disposable and ignored by version control.

The model registry is intentionally provider-shaped. Each provider owns model
loading and inference, but returns ordered, normalized OCR blocks. The core
owns page selection, comparison, caching, the Book contract and EPUB output.
Adding a model therefore does not add a second document pipeline.
The complete boundary and provider checklist are in
[docs/STUDIO.md](docs/STUDIO.md).

The CLI has three commands (via `npx tsx src/cli.ts …` or `npm run build` then
`node dist/cli.js …`):

| Command | Does |
|---|---|
| `bookforge pdf in.pdf book/ [--title T] [--author A] [--lang L] [--pages 1,3-5] [--ocr]` | PDF → editable `book.json` + `assets/` |
| `bookforge unpack in.epub book/` | EPUB → editable `book.json` + `assets/` |
| `bookforge validate book/` | check a book folder, print issues with paths |
| `bookforge pack book/ out.epub` | book folder → EPUB (refuses invalid input) |
| `bookforge studio [--port 4173]` | launch the local visual OCR and EPUB workbench |

`--ocr` uses [PaddleOCR-VL 1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6).
Its dependencies are pinned in [tools/pyproject.toml](tools/pyproject.toml)
(Python 3.9–3.13, PaddlePaddle 3.2.1, `paddleocr[doc-parser]` 3.6.0+). Install
it in a dedicated virtual environment:

```sh
uv venv --python 3.13 .venv-paddleocr
uv pip install --python .venv-paddleocr/bin/python -r tools/pyproject.toml
export BOOKFORGE_PADDLEOCR_PYTHON="$PWD/.venv-paddleocr/bin/python"
```

On Apple Silicon the official local route uses `cpu`; set
`BOOKFORGE_PADDLEOCR_DEVICE=cpu`. GPU hosts can select a Paddle device such as
`gpu:0`. Direct Apple CPU inference is very slow. Paddle's supported accelerated
Apple path keeps layout analysis local and serves the VLM with MLX-VLM (the
`mlx` extra in `tools/pyproject.toml`):

```sh
uv pip install --python .venv-paddleocr/bin/python -r tools/pyproject.toml --extra mlx
.venv-paddleocr/bin/mlx_vlm.server --port 8111
export BOOKFORGE_PADDLEOCR_VL_BACKEND=mlx-vlm-server
export BOOKFORGE_PADDLEOCR_VL_SERVER_URL=http://localhost:8111/
export BOOKFORGE_PADDLEOCR_VL_MODEL_NAME=PaddlePaddle/PaddleOCR-VL-1.6
```

The first OCR run downloads the official models. The typical PDF→EPUB flow is
`bookforge pdf` … inspect/fix `book.json` … `bookforge pack`.

## Repo layout

```
DESIGN.md          the why: evidence, architecture, roadmap
tools/             ocr-paddle.py — persistent PaddleOCR-VL 1.6 bridge
src/
  contract.ts      schema, validator, block walker
  inline.ts        the inline dialect: parse + render
  fixtures.ts      the design doc's own example book, used as a permanent fixture
  epub/write.ts    contract → EPUB3
  epub/read.ts     EPUB → contract
  pdf/textlayer.ts per-page verdict: which pipeline a page needs
  pdf/extract.ts   mupdf wrapper: runs, lines, images, bookmarks
  pdf/passes.ts    classify / unwrap / outline
  pdf/ocr.ts       OCR adapter interface + PaddleOCR-VL 1.6 engine
  pdf/pdf.ts       the front-end orchestrator
  models/          model registry, installation and provider construction
  studio/server.ts local Studio API and static app server
  cli.ts           pdf / unpack / pack / validate
  *.test.ts        the tests live next to what they test
studio/            local drag/drop OCR comparison and contract editor UI
```
