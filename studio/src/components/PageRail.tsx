import { useState } from "react";
import type { PageReport } from "../api";
import { pageImageUrl } from "../api";

function parseRange(input: string, max: number): number[] {
  const pages = new Set<number>();
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [, a, b] = range;
      for (let n = Number(a); n <= Number(b); n++) if (n >= 1 && n <= max) pages.add(n);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= max) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

const verdictLabel: Record<PageReport["verdict"], string> = {
  native: "native",
  scanned: "scan",
  "no-text": "blank",
};

export function PageRail({
  documentId,
  pages,
  selected,
  onSelectedChange,
  samplePage,
  onSamplePageChange,
}: {
  documentId: string;
  pages: PageReport[];
  selected: Set<number>;
  onSelectedChange: (next: Set<number>) => void;
  samplePage: number | null;
  onSamplePageChange: (page: number) => void;
}) {
  const [range, setRange] = useState("");

  const toggle = (page: number) => {
    const next = new Set(selected);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    onSelectedChange(next);
  };

  return (
    <div className="page-rail">
      <div className="page-rail-controls">
        <button type="button" className="btn-ghost btn-small" onClick={() => onSelectedChange(new Set(pages.map((p) => p.page)))}>
          all
        </button>
        <button type="button" className="btn-ghost btn-small" onClick={() => onSelectedChange(new Set())}>
          none
        </button>
        <button
          type="button"
          className="btn-ghost btn-small"
          onClick={() => onSelectedChange(new Set(pages.filter((p) => p.verdict !== "no-text").map((p) => p.page)))}
        >
          skip blanks
        </button>
      </div>
      <div className="page-rail-range">
        <input
          placeholder="e.g. 1,3-5,9"
          value={range}
          onChange={(e) => setRange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSelectedChange(new Set(parseRange(range, pages.length)));
          }}
        />
        <button type="button" className="btn-ghost btn-small" onClick={() => onSelectedChange(new Set(parseRange(range, pages.length)))}>
          apply
        </button>
      </div>
      <p className="muted small">{selected.size} of {pages.length} pages selected for output · click a thumbnail to use it as the model comparison sample</p>
      <div className="page-grid">
        {pages.map((p) => (
          <div key={p.page} className={"page-thumb" + (samplePage === p.page ? " is-sample" : "")}>
            <button type="button" className="page-thumb-image" onClick={() => onSamplePageChange(p.page)} title="use as comparison sample">
              <img src={pageImageUrl(documentId, p.page, 0.3)} alt={`page ${p.page}`} loading="lazy" />
              {samplePage === p.page && <span className="sample-star">sample</span>}
            </button>
            <label className="page-thumb-footer">
              <input type="checkbox" checked={selected.has(p.page)} onChange={() => toggle(p.page)} />
              <span>{p.page}</span>
              <span className={"verdict verdict-" + p.verdict}>{verdictLabel[p.verdict]}</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
