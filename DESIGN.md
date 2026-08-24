# Bookforge — Design Document

**Status:** draft v0.2 — pre-implementation
**Date:** 2026-08-24

**Changes in v0.2** (from review of v0.1):

1. Footnotes re-modeled: stable ids, block-list bodies (v0.1's string map had
   the same limitation we criticize Markdown for, and per-chapter numbering
   collided).
2. Anchor mechanism added: optional `id` on every block, inline link syntax.
   Cross-references could not survive round-trip without it.
3. Inline dialect §4.3 added: exact feature list and escaping rules. Literal
   `$`, `*`, `_`, `[`, `^` in extracted text were previously undefined and
   would silently become markup.
4. `annotations` gain a required `matches` field; offsets are validator-checked
   against it (v0.1's own example had wrong offsets — silent corruption was
   the default failure mode).
5. Invariant I3 restated from "never delete" (contradicted by `classify` and
   `unwrap` as specified) to "never lose information" with explicit demote and
   merge rules.
6. Page-break offsets on multi-page blocks, recorded at `unwrap` time, so the
   EPUB page-list can anchor mid-paragraph.
7. Smaller: per-language dehyphenation noted on `unwrap`; `roundtrip` needs a
   written equivalence definition; nesting-cap image fallback's rasterizer
   cost recorded in §9.

---

## 1. Goal

**Make a real EPUB from a PDF.**

"Real" means reflowable body text with figures, tables, footnotes and
cross-references intact and correctly anchored — not a page-image container,
not a wall of undifferentiated paragraphs.

This is not our phrasing. It is the title of a MobileRead forum thread from
2018: *"PDF (with OCR) to ePub, is it possible to make a real ePub?"* The same
question has been asked there under different titles in 2016, 2017, 2019 and
2023. In a healthy tool ecosystem that thread is asked once and pinned.

### 1.1 Non-goals

Stated explicitly because each was considered and cut:

- **We do not build OCR.** Solved elsewhere, better than we could.
- **We do not build layout-detection models.** Same.
- **We do not reproduce the PDF's visual layout.** Fixed-layout EPUB already
  exists (`pdf2epubEX`, `pdf2fxl`, `pdf2epub3fixed`) and is useless on a 6"
  screen. "Exactly the same" and "reflowable" are mutually exclusive; we chose
  reflowable.
- **We do not target RAG or LLM ingestion.** Marker, MinerU and Docling own
  that. Our target is a human reading a book on an e-reader.
- **We do not require a GPU** on the born-digital path.

---

## 2. Evidence: the problems, and where they were reported

Rule applied throughout: **a problem is only on this list if it was reported by
users or maintainers in at least two independent places.** Nothing here is our
own inference about what users might want.

### Tier 1 — reported in 3+ independent sources

| # | Problem | Where reported |
|---|---------|----------------|
| P1 | Hyphenation and paragraph unwrapping broken | calibre ships a "Line un-wrapping factor" heuristic knob as the workaround; pdf-craft #296 (hyphenated words mangled); marker #1024 (list logic strips internal hyphens) |
| P2 | Double-layer PDFs (scan + hidden OCR text) mishandled | calibre manual: uses the OCR text, "which can be very different from what you see when you view the PDF file"; pdf-craft #360, #363; Adobe community thread: every page appears twice in the output EPUB |
| P3 | Heading / TOC hierarchy wrong | Cross-tool testing (jimmysong.io): "All these tools share a common issue: PDF document outline recognition is not accurate enough, especially for multi-level headings and section order, which may require manual adjustment"; paip-lisp release notes: "chapter links in the Preface chapter don't work... many more chapter links that have never been fixed up to work at all"; calibre ships a manual TOC Editor as the escape hatch |
| P4 | Tables degraded or dropped | calibre manual: "Extraction of vector images and tables from within the document is also not supported"; pdf-craft #319 (native markdown tables requested); paip-lisp: "some tables have irregular column widths" |

### Tier 2 — reported in 2 independent sources

| # | Problem | Where reported |
|---|---------|----------------|
| P5 | Images missing, or cropped incorrectly | marker #1026 (no way to force image links for all embedded images); MinerU per hands-on testing "sometimes cropping images incompletely"; pdf-craft #360 |
| P6 | Long runs die, leak, or can't resume | pdf-craft #362 (conversion ends prematurely); marker #1040 (unbounded memory growth across documents) |
| P7 | Heavyweight install / GPU required | pdf-craft #369 (requests cloud OCR fallback), #320 (CPU thread tuning); marker #1038 (VRAM contention with local LLM); practitioner writeup documents manual relaunch on OOM and adding 64GB swap for long books |

### Tier 3 — single source, high impact, HELD

Not yet acted on. Promoted to Tier 1 only if a second independent report
appears.

| # | Problem | Where reported |
|---|---------|----------------|
| P8 | Italics silently lost | marker #1020: "In Principle, Italics Detection Exists, But Often Fails" |
| P9 | Ligatures mangled (ll, ff, fi) | calibre manual |
| P10 | RTL and math typesetting fail | calibre manual: "will not convert correctly" |
| P11 | Non-Unicode embedded fonts → garbled non-English text | calibre manual |

### 2.1 The incumbent's own verdict

The strongest evidence is not a user complaint. It is the documentation of the
tool everyone recommends. From the calibre manual:

> "PDF documents are one of the worst formats to convert from... To re-iterate
> PDF is a really, really bad format to use as input. If you absolutely must
> use PDF, then be prepared for an output ranging anywhere from decent to
> unusable, depending on the input PDF."

Calibre is the default answer given on Adobe's forums, Hacker News, Goodreads
and itch.io. Calibre says don't. That gap is the opportunity.

### 2.2 Ideas we cut for lack of evidence

Recorded so they are not silently reintroduced:

- **Vector-graphics passthrough (figures as SVG).** Our idea, not requested by
  anyone. Additionally, pdf-craft #360 asks for the *opposite* — the user wants
  the complete original image preserved intact, not decomposed.
- **Per-block confidence scoring / QA view.** Our idea. Retained only as an
  internal field, not as a product feature, until someone asks.

---

## 3. Architecture

### 3.1 The core decision

A neutral document contract sits between input parsing and output emission.
Front ends produce it; back ends consume it. N×M becomes N+M.

```
                            ┌──────────────┐
   PDF (native) ───────────►│              │
   PDF (scanned) ──────────►│   CONTRACT   │───► EPUB3
   EPUB ───────────────────►│  (book.json) │───► (later: HTML, DAISY, MD)
                            └──────────────┘
                                   ▲
                          IR → IR passes operate here
```

### 3.2 Three invariants

These are the rules that keep the design from collapsing back into a
PDF-shaped format.

**I1 — The page is metadata, never a container.**
`content` is one flat ordered list for the whole book. Blocks carry
`page` / `pages` for provenance and page-list generation, but nothing nests
under a page.

*Why:* every Tier-1 problem is a thing that crosses a page boundary — a
paragraph split across pages 46–47, a footnote continuing onto the next page, a
figure on 47 referenced from 45. A page-keyed structure cannot express any of
them. Marker's JSON is a list of pages; Docling's DoclingDocument was built for
RAG. Both already exist and neither can hold a book. If we build a third
page-keyed JSON we have solved nothing.

**I2 — Store role, not position.**
A pull-quote is `{type: "quote", role: "pullquote"}`, never "14pt italic at
x=340,y=200". Coordinates are debug-only and are not written to `book.json` at
all.

*Why:* this is the single rule that makes the contract multi-format instead of
PDF-shaped, and the reason we cannot accidentally drift into fixed-layout.

**I3 — Passes must never lose information.**
*(Restated in v0.2; the v0.1 wording "only add or upgrade fields, never
delete" was contradicted by `classify` and `unwrap` as specified.)*
Concretely, a pass may:

1. **Add** a field, or **upgrade** a `null` field to a value.
2. **Demote** a block by setting a role (`role: "running-header"`,
   `role: "page-number"`, `role: "artifact"`). Emitters skip demoted roles.
   Passes never physically remove a block — demotion is reversible by editing
   one field; deletion is not.
3. **Merge** blocks (lines → paragraph, cross-page halves → one block),
   provided the merged block records provenance: source pages with break
   offsets (§4.4). Merging is the only operation that reduces block count,
   and only `unwrap` and `listify` are licensed to do it.

A pass never deletes a field, never rewrites text it did not merge, and never
downgrades a value back to `null`. This keeps passes order-tolerant,
independently testable, and safe to add later.

### 3.3 Fidelity levels — how we keep the door open for tables and math

Every block type exists in the contract from day one, including the ones we
cannot yet fully parse. What varies is how much is filled in.

```jsonc
// today
{ "type": "table", "image": "assets/tab-2-2.png", "rows": null }

// after the `grid` pass ships — same schema, no migration
{ "type": "table", "image": "assets/tab-2-2.png",
  "rows": [["Melange", "€4.20"], ["Einspänner", "€4.80"]] }
```

The emitter rule is written once: **`rows` present → `<table>`, else →
`<figure><img>`.** Identically for math: `tex` present → MathML, else image.

Consequence: **adding the table recognizer or math recognizer in month six
changes zero lines of back-end code and zero lines of schema.** Nothing
downstream notices except that output improved. Addresses P4 and P10 without
blocking v1 on them.

This also gives graceful degradation — the same choice made deliberately by
`Academical-Paper-Converter-To-Epub`, which crops every figure, table, equation
and plot to an image rather than parsing it badly. Ours is the same behaviour,
but as a state that improves rather than a permanent surrender.

---

## 4. The contract

Format: **JSON**, 2-space indent. (YAML rejected: multi-line prose handling and
indentation sensitivity break down at 40k lines, plus type-coercion footguns —
a book about Norway with `no` as a value silently becomes `false`.)

Output is a folder, not a single file. Images stay as files; base64 would bloat
the JSON ~33% for zero gain.

```
book/
  book.json
  assets/
```

Excerpt from a real book (blocks 38–47 of a physics text). Prose strings are
shown wrapped here for readability; in the file they are single JSON strings.

```jsonc
{
  "title": "Feldtheorie",
  "author": "K. Weiss",
  "language": "de",
  "cover": "assets/cover.jpg",
  "content": [
    { "type": "heading", "level": 2, "id": "sec-2-3",
      "text": "2.3 Die Lagrange-Dichte", "page": 41 },
    { "type": "text",
      "text": "Die Bewegungsgleichungen eines Feldes lassen sich aus einem Variationsprinzip herleiten. Wir betrachten die Wirkung $S$ als Funktional der Feldkonfiguration.",
      "page": 41 },
    { "type": "text",
      "text": "Der Übergang zur Feldtheorie erfolgt, indem $q_i(t)$ durch das Feld $\\phi(x,t)$ ersetzt wird.[^ch2-fn7]",
      "pages": [ { "page": 41 }, { "page": 42, "at": 53 } ] },
    { "type": "formula", "display": true, "id": "eq-2-14",
      "tex": "S[\\phi] = \\int d^4x \\, \\mathcal{L}(\\phi, \\partial_\\mu \\phi)",
      "number": "2.14", "page": 42 },
    { "type": "formula", "display": true,
      "tex": null, "image": "assets/eq-2-15.png",
      "note": "margin annotation, not parsed", "page": 42 },
    { "type": "quote",
      "text": "Le principe de moindre action est le plus beau théorème de la mécanique.",
      "language": "fr", "attribution": "Maupertuis", "page": 43 },
    { "type": "image", "file": "assets/fig-2-4.png",
      "caption": "Feldkonfiguration mit stationärer Wirkung.", "page": 43 },
    { "type": "text",
      "text": "Für Felder mit *innerer Symmetrie* führt dies auf die Noether-Ströme, wie in [Gl. 2.14](#eq-2-14) angelegt.",
      "page": 43 },
    { "type": "table", "image": "assets/tab-2-2.png", "rows": null,
      "caption": "Kopplungskonstanten.", "scanned": true, "page": 44 }
  ],
  "footnotes": {
    "ch2-fn7": {
      "label": "7",
      "blocks": [
        { "type": "text",
          "text": "Vgl. Landau & Lifschitz, *Klassische Feldtheorie*, §2." }
      ]
    }
  }
}
```

### 4.1 Design principle for inline content

**Markdown inline for what markdown does well; explicit fields for what it
can't.**

- `*em*`, `**strong**`, `[^id]`, `$math$`, `[text](#id)` — inline in the text
  string. The full dialect is specified in §4.3.
- `language`, `page`, `caption`, `attribution` — explicit fields.
- Anything the dialect has no syntax for (a foreign phrase mid-sentence,
  small-caps) uses an `annotations` array (§4.5), present only on the rare
  blocks that need it.

Rationale: a span-array format is unreadable and unhand-editable. Because the
contract is human-readable, `book.json` doubles as an **editing format** — fix
the three things the parser got wrong, re-emit. No tool in this space offers
that; the current state of the art is "positioning is 95% reliable, fine-tune
it in Sigil."

### 4.2 Anchors and cross-references

*(New in v0.2.)* "Cross-references intact and correctly anchored" is the first
sentence of this document; v0.1 had no mechanism for it.

- Every block accepts an optional `id`: lowercase kebab-case, unique across
  the book, stable under re-runs (derived from role + number/text, not from
  position — `sec-2-3`, `eq-2-14`, `fig-2-4`, never `block-38`).
- Inline links use `[text](#id)` and may target any block id or footnote id.
- The validator rejects a link whose target id does not exist. Dangling links
  found by the front end (paip-lisp's "chapter links that don't work") are
  demoted to plain text *by the front end* with a warning — the contract
  itself never contains a dangling link.
- Front ends must emit ids for every heading and every numbered
  figure/table/formula, because those are the things books link to.
- External links are ordinary Markdown links with absolute URLs.

### 4.3 The inline dialect

*(New in v0.2.)* The dialect is closed: exactly these seven constructs, nothing
else from Markdown. The `contract` package ships the tokenizer; front ends,
passes and back ends all use it — nobody regexes text strings.

| Construct | Syntax | Notes |
|---|---|---|
| Emphasis | `*text*` | |
| Strong | `**text**` | |
| Inline math | `$tex$` | Never spans block boundaries |
| Footnote ref | `[^id]` | `id` must exist in `footnotes` |
| Internal link | `[text](#id)` | `id` must exist (§4.2) |
| External link | `[text](https://…)` | Absolute URLs only |
| Escape | `\` before any special | See below |

**Escaping.** The characters `\` `*` `$` `[` `]` `^` are special. Extracted
text containing them literally MUST be backslash-escaped by the front end:
a book that says "costs $4 to $5 per unit" is stored as
`"costs \\$4 to \\$5 per unit"`. `_` is **not** special (underscore-emphasis is
excluded from the dialect precisely because literal underscores are common in
technical text). The tokenizer round-trips: `render(parse(s)) === s` for every
valid string, and this is property-tested in the `contract` package.

No headings-in-text, no inline code, no images-in-text, no HTML. Anything not
in the table is a literal character (or a validation error, for unescaped
specials that form ambiguous sequences).

The dialect applies to **every** text-bearing string: block text, captions,
and table cells (`rows`). *(Added 2026-08-24 after the first corpus run:
Gutenberg renders its table of contents as a `<table>` of links — plain-string
cells silently stripped them.)*

### 4.4 Page provenance and break offsets

*(Expanded in v0.2.)* A block on one page carries `page: 41`. A block merged
across pages carries:

```jsonc
"pages": [ { "page": 41 }, { "page": 42, "at": 53 } ]
```

`at` is the offset into `text` (Unicode code points, counting markup
characters) where that page begins. `unwrap` knows this at merge time and it is
unrecoverable later; recording it costs one number and makes the EPUB
page-list able to anchor "page 42" mid-paragraph instead of at the nearest
block boundary. DAISY page navigation — one of our test suites — requires
exactly this.

### 4.5 Annotations

*(Hardened in v0.2.)* For spans the dialect cannot express:

```jsonc
{ "type": "text",
  "text": "Er nannte es ein Gefühl von joie de vivre, das ihm fehlte.",
  "annotations": [
    { "start": 28, "end": 41, "matches": "joie de vivre", "language": "fr" }
  ] }
```

- Offsets are Unicode code point indices into the raw `text` string (markup
  characters count).
- `matches` is **required** and the validator checks
  `text.slice(start, end) === matches`. A hand-edit that shifts offsets is a
  validation error, not silent corruption. (The v0.1 draft of this very
  example carried wrong offsets — 30/44 for a span at 28/41 — which is the
  argument for `matches` in one line.)
- Tooling rule: anything that edits `text` re-derives offsets from `matches`;
  a human who edits by hand only has to keep `matches` in sync and can let
  `bookforge fix-offsets` recompute the numbers.

### 4.6 Known open question

At 300 pages `book.json` is ~40k lines. If git diffs prove painful, switch
`content` to JSON Lines (one block per line) for streamability and clean
line-level diffs. **Decide with data once the extractor works, not now.**

---

## 5. Decomposition into tools

Each tool solves one problem and is independently useful. Passes 6–11 depend on
**nothing but the contract** — they are pure `Doc -> Doc` functions, usable by
anyone, including competing projects.

### Foundation

| # | Tool | Does | Addresses |
|---|------|------|-----------|
| 1 | `contract` | Schema + validator (Zod: types and validation from one definition) + the inline-dialect tokenizer (§4.3) | — |

### Front end

| # | Tool | Does | Addresses |
|---|------|------|-----------|
| 2 | `textlayer` | Per-page verdict: `native` / `scanned` / `no-text`; hidden OCR layers are ignored | **P2** |
| 3 | `extract` | Native path: text runs with font name+size, images, link annots, bookmarks, page labels | P5, P8 |
| 4 | `ocr-adapter` | PaddleOCR-VL 1.6 full document pipeline → ordered blocks+boxes. **Optional dependency** | P7 |
| 5 | `assets` | Extract image/region bytes, dedupe by hash, write files | P5 |
| — | `epub-read` | EPUB → contract. Needed for the round-trip harness | — |

### IR → IR passes (`Doc -> Doc`)

| # | Tool | Does | Addresses |
|---|------|------|-----------|
| 6 | `classify` | Type blocks; demote running headers/footers/page numbers (`role`, per I3 — never removed) | — |
| 7 | `flow` | Reading order, column detection | — |
| 8 | `unwrap` | Lines → paragraphs, dehyphenation, cross-page merge (records break offsets §4.4). Dehyphenation is per-language: hyphenation dictionary keyed by `language`, and soft (line-break) hyphens distinguished from hard ones — German is the stress test: compounds hyphenate at points no dictionary lists ("Feld-theorie" → rejoin) while "E-Book" split at its real hyphen keeps it | **P1** |
| 9 | `listify` | List detection and reconstruction | P1 |
| 10 | `bind` | figure↔caption, noteref↔footnote | — |
| 11 | `outline` | Heading tree, cross-checked against TOC pages; emits stable heading ids (§4.2) | **P3** |
| 12 | `grid` | *Later.* Cell geometry → `rows` | P4 |
| 13 | `mathpass` | *Later.* Region → `tex` | P10 |
| 14 | `assist` | *Later.* LLM, low-confidence blocks only | — |

### Back end

| # | Tool | Does | Addresses |
|---|------|------|-----------|
| 15 | `epub3` | Contract → epubcheck-clean EPUB3: `<figure>/<figcaption>`, real `<table>`, `epub:type="footnote"`, nav doc, page-list (anchored via §4.4 offsets) | P3, P4 |

### Infrastructure

| # | Tool | Does | Addresses |
|---|------|------|-----------|
| 16 | `pagecache` | Content-addressed per-page results; resumable | **P6** |
| 17 | `roundtrip` | EPUB → contract → EPUB, semantic diff (equivalence defined in §5.2) | — |

### 5.1 Notes on specific tools

**`textlayer` is the highest-leverage tool and nobody has built it standalone.**
It is the routing decision the entire pipeline depends on, and every existing
tool guesses. Getting it right removes much of the "decent to unusable"
variance calibre warns about. Method: inspect font encodings (non-Unicode CMaps
→ garbled), dictionary hit-rate on extracted text, and for double-layer pages
compare text-layer word boxes against ink density in the page image. No ML.

**Four of the six Tier-1/2 problems are not ML problems.** P1 is geometry plus a
hyphenation dictionary. P2 is encoding inspection. P3 is string matching against
TOC pages. P6 is caching. They have stayed broken for a decade because they were
buried inside ML pipelines where nobody isolated or tested them — they are
nobody's job. That is the opening.

**Marker/MinerU/Docling are a swappable dependency, never a competitor.** We
consume their block JSON on the scanned path. On the native path we do not use
them at all, and are strictly more accurate for it: marker #1020 (italics
inference failing) is a self-inflicted wound of rasterising a page whose font is
literally named `TimesNewRoman-Italic` in the file. You do not infer italics
from pixels; you read a string.

### 5.2 Round-trip equivalence

*(New in v0.2.)* "Semantic diff" is meaningless until equivalence is written
down; without this the harness drowns in false positives. Two EPUBs are
equivalent iff, per spine document, after normalization:

- text content is identical (Unicode NFC, whitespace runs collapsed,
  inter-block whitespace ignored);
- block structure is identical (element category sequence — paragraph,
  heading+level, figure, table, quote, list — not tag names: `<i>` vs
  `<em class="x">` is equivalent);
- anchors resolve identically (every internal link lands on the same text);
- `epub:type` semantics match where present (footnote, page-list, TOC);
- images are byte-identical after container re-encoding is excluded.

Ignored entirely: attribute order, class names, generated ids' spelling, CSS,
file naming and manifest ordering.

---

## 6. Why this is not "binding libs together"

Every pass is independently adoptable. `unwrap` and `textlayer` close open
issues in pdf-craft, marker and MinerU simultaneously. If the combined product
goes nowhere, the tools still fixed the ecosystem. If the tools get adopted, the
product inherits their credibility.

The alternative — a monolith wrapping marker that emits EPUB — dies the moment
marker's API changes, and fixes nothing for anyone else.

Positioning: current standard advice is *"convert PDF to Markdown with one of
these, then hand the Markdown to Pandoc."* Markdown physically cannot carry
captions bound to figures, footnotes containing images, or page-lists. Every
conversion in the world squeezes through that pipe and loses exactly those
things. **We replace the Pandoc step.** (And our own footnote model is
block-structured for the same reason — see §4, v0.2 change 1: a footnote is a
list of blocks, so a footnote containing an image is representable, unlike in
Markdown and unlike in our own v0.1.)

---

## 7. Implementation

**Language: TypeScript.** Discriminated unions on `type` make the emitter's
exhaustive `switch` compiler-checked — adding `formula` later fails to build
until it is handled. Zod gives schema + types from one definition. Browser demo
becomes trivial later, which no competitor has.

**Dependencies (v1):** `zod`, `fast-xml-parser`, `jszip`. Later, for PDF:
`mupdf` (WASM) or `@hyzyla/pdfium`. **No torch, ever, on the native path.**

**Accepted cost:** `unwrap` / `outline` cannot be dropped into the Python
ecosystem as pip packages. Mitigation: expose every pass behind a CLI with JSON
in/out so those projects can shell out.

### 7.1 Phase 0 — de-risk (1 day)

Spike the PDF library. Load one born-digital page and print:

1. text runs with font name and size
2. embedded image bytes
3. link annotations with targets
4. the bookmark tree

All four present → TypeScript is settled. Missing → fall back to a thin
Rust/Go sidecar for `extract` only; everything else stays TS. **Know this now,
not in month three.**

*Resolved 2026-08-24:* `mupdf` 1.28.0 (WASM) passes all four on a handcrafted
test PDF (`spike/`): per-run font name + size (`Times-Italic` read as a
string, confirming the §5.1 argument against pixel inference), embedded image
bytes via `StructuredText.walk`, external + internal links with resolved
destinations, nested outline via `loadOutline()`. No `getPageLabels()`
convenience method, but the raw object API (`getTrailer().get("Root")…`)
reaches `PageLabels` fine. TypeScript settled; no sidecar.

### 7.2 Phase 1 — build the back half (days 2–7)

Build `contract`, `epub-read`, `epub3`.

This is not testing before building; it *is* building — three of the seventeen
tools, none throwaway. `epub3` is the final output stage of the entire product.

We build the back half first because it has a known-correct target: real EPUBs
already exist to check against. The PDF front end has no ground truth until the
back end works.

```
bookforge/
  src/
    contract.ts      ← schema, validateBook, walkBlocks
    inline.ts        ← §4.3 tokenizer, part of the contract package
    fixtures.ts      ← the §4 excerpt as a permanent test fixture
    epub/read.ts
    epub/write.ts
    cli.ts           ← unpack / pack / validate
```

*Status 2026-08-24: built, 63 tests green (TDD throughout). The §4 fixture
round-trips contract → EPUB → contract exactly — including footnotes, the
mid-paragraph page-break offset (recovered as `pages[].at` from the pagebreak
span position), annotations, tables both fidelity levels, and formula TeX
(carried losslessly in MathML `<annotation encoding="application/x-tex">`;
real TeX→MathML rendering remains `mathpass`'s job). Not yet run: epubcheck
(needs the Java jar) and the Phase 2 corpus.*

### 7.3 Phase 2 — validate the schema (days 8–10)

Run `roundtrip` and produce the **losses table**:

```
structure              books using it    survives round-trip
------------------------------------------------------------
figure + figcaption         18/20              yes
footnote/noteref            14/20              yes
blockquote + cite           12/20              partial  ← attribution lost
definition list              6/20              no       ← not in schema
poetry line breaks           4/20              no       ← not in schema
```

**That table is the v1 spec — derived from real books, not assumed.** Freeze the
schema only after it exists.

Test corpus, in order:

1. `w3c/epub-tests` — `generateEpubs.sh` builds one EPUB per normative feature.
   Failures point at exactly one thing.
2. `daisy/epub-accessibility-tests` — prebuilt EPUBs on the releases page.
   `epub:type` vocabulary, footnotes, page-list, MathML.
3. Three Standard Ebooks — *Dorian Gray* (footnotes, epigraphs), *Dracula*
   (letters, diary entries), *Ulysses* (poetry, drama, multi-language). Their
   XHTML source is on GitHub, so any loss can be diagnosed against the original.
   **Do not crawl standardebooks.org** — the site carries a scraper honeypot
   link that bans the IP for 24 hours. Download by hand or use their OPDS feed.
4. One OpenStax textbook — tables and MathML.
5. `norvig/paip-lisp` — held until Phase 3. Its releases contain both the
   original scanned PDF *and* a human-made EPUB of the same book: a ground-truth
   pair, which is rare. Its release notes also document precisely the failures
   we target (dead chapter links, irregular table columns).

Stop at three real books. If *Dorian Gray* already loses something unpredicted,
fix the contract before adding corpus.

### 7.4 Phase 3 — the front end

`textlayer` → `extract` → `assets`, then passes 6–11, in that order. First
milestone: a born-digital PDF converted to an EPUB with correct headings,
paragraphs, figures and footnotes.

*Status 2026-08-24: first milestone reached, on all three input flavors
(`src/pdf/`). Scan-backed pages now have one route: `scanned` always renders
the visible page through the complete PaddleOCR-VL 1.6 pipeline. This includes
double-layer PDFs; their hidden OCR text is deliberately ignored. Corpus:
Planet eBook born-digital ×3 (native: correct chapters, *em*
from font names, soft-hyphen + evidence-based dehyphenation, drop-cap
absorption, footer stripped, printed-page provenance incl. mid-paragraph
break offsets). PaddleOCR-VL returns layout-aware reading order and recognizes
109 languages; `--lang` remains part of the cache identity and book metadata.
Known limits, recorded not hidden: PaddleOCR-VL corpus quality still needs a
fresh full-book benchmark; no figure extraction on scanned pages yet.*

### 7.5 Later

`ocr-adapter`, then `grid`, `mathpass`, `assist`. Second back end (HTML or
DAISY) only after the first produces a book worth reading.

---

## 8. How we know it worked

1. **Round-trip is lossless** on the W3C and DAISY suites, under the §5.2
   equivalence definition.
2. **`unwrap` beats calibre and pdf-craft measurably** on a corpus of 500
   hyphenated line-pairs with known answers. Nobody has ever published that
   number.
3. **A born-digital book converts with correct TOC, figures, footnotes and
   italics** — a book we would actually read.
4. **Install is one command, no GPU, works offline.**
5. **At least one pass is upstreamed** into pdf-craft, marker or MinerU.

---

## 9. Open questions

Recorded rather than guessed at:

- **Ratio of born-digital to scanned** among books people actually want
  converted. Determines build order. *Method: sample 20–50 real target PDFs and
  count.*
- **Whether Reddit/MobileRead thread bodies confirm P8–P11.** If italics or RTL
  appear repeatedly there, they promote to Tier 1 and gain tools.
- **JSON vs JSON Lines** at book scale (§4.6).
- ~~**PDF library capability**~~ — resolved by Phase 0: `mupdf` WASM
  suffices (§7.1).
- **Nesting depth.** A list inside a quote inside an aside is ugly in a flat
  structure. Provisional cap: two levels, deeper falls back to an image region.
  Confirm against the losses table. *Noted (v0.2): the image fallback quietly
  requires a page rasterizer, which the native path otherwise never needs.
  If the losses table shows deep nesting is rare, prefer flattening-with-role
  over rasterizing so the native path stays render-free.*

---

## Appendix A — sources

**Repositories:** `oomol-lab/pdf-craft` (46 open issues) · `datalab-to/marker`
(344 open) · `opendatalab/MinerU` · `docling-project/docling` ·
`kovidgoyal/calibre` · `norvig/paip-lisp` · `w3c/epub-tests` ·
`daisy/epub-accessibility-tests` · `dodeeric/pdf2epubEX` ·
`aourednik/pdf2epub3fixed` · `transpect/pdf2fxl` ·
`enderonat/Academical-Paper-Converter-To-Epub`

**Issues cited:** pdf-craft #296, #319, #320, #326, #353, #360, #362, #363,
#369 · marker #1020, #1024, #1026, #1035, #1038, #1040

**Documentation:** calibre manual, "E-book conversion" §PDF ·
W3C EPUB 3.3 specification

**Community:** MobileRead Forums (thread titles 2016–2023) · Adobe Community
(Acrobat / Digital Editions) · Hacker News · jimmysong.io cross-tool comparison
· techshinobi.org MinerU-for-books writeup

**Not consulted — gap in research:** Reddit (r/ebooks, r/kobo, r/Calibre,
r/LocalLLaMA, r/DataHoarder) and MobileRead thread bodies. Titles only were
available. Tier 3 promotion depends on this.
