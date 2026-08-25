# Contributing to Bookforge

## Setup

```sh
npm install
npm test
```

That's it for the core library and CLI — no Python, no models, no GPU. Only
the OCR path (scanned PDFs, or the Studio's model comparison) needs the
PaddleOCR environment described in [README.md](README.md#using-it).

To work on the Studio UI:

```sh
npm run studio:dev
```

This runs the Vite dev server (`studio/`, hot reload) against the local API
(`src/studio/server.ts`). `npm run studio` builds the UI once and serves it
from the same Node process, which is what `bookforge studio` does in
production.

## Where things live

Read [README.md](README.md#repo-layout) for the layout and
[DESIGN.md](DESIGN.md) for *why* it's shaped this way before changing the
contract (`src/contract.ts`) or the pipeline architecture — the three
invariants in DESIGN.md §3.2 (page-as-metadata, role-not-position,
passes-never-lose-information) are load-bearing and any change that violates
one needs a design-doc update, not just a code change.

## Adding an OCR model provider

The Studio's model comparison is provider-shaped by design — see
[docs/STUDIO.md](docs/STUDIO.md) for the ownership boundary between the
TypeScript core and a model's own runtime, and its "Next provider checklist"
for the concrete steps (implement the JSONL protocol, normalize to
`OcrBlock`, register in `src/models/registry.ts`, add mapper fixtures).

## Tests

- `npm test` runs the full Vitest suite. Tests live next to what they test
  (`*.test.ts`).
- `src/pdf/pdf.test.ts` and a few others read real PDFs from `corpus/pdf/` —
  keep that directory to genuine test inputs; do not commit generated
  `book.json`/EPUB output there.
- A schema or inline-dialect change should keep `render(parse(s)) === s`
  round-tripping (DESIGN.md §4.3) and the contract → EPUB → contract
  round-trip in `src/epub/*.test.ts` green.

## Pull requests

CI runs `npm run build` and `npm test` on every PR — keep both green. Small,
focused PRs over large ones; a pass in DESIGN.md §5 (`unwrap`, `outline`,
etc.) is meant to be independently useful and independently reviewable.
