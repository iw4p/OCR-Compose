import { useState } from "react";
import type { Doc } from "../api";
import { allPages, pagesWithContent, parseRange, togglePage } from "../pages";
import { formatBytes } from "../format";

const VERDICTS = [
  { key: "native", label: "native text" },
  { key: "scanned", label: "scanned" },
  { key: "no-text", label: "blank" },
] as const;

export function FileCard({
  doc,
  selected,
  onSelected,
  onReset,
}: {
  doc: Doc;
  selected: Set<number>;
  onSelected: (pages: Set<number>) => void;
  onReset: () => void;
}) {
  const [range, setRange] = useState("");

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{doc.name}</h2>
          <p className="sub">
            {doc.pageCount} pages · {formatBytes(doc.sizeBytes)}
          </p>
        </div>
        <button type="button" className="btn ghost" onClick={onReset}>
          different file
        </button>
      </header>

      <div className="verdict-bar">
        {VERDICTS.map(({ key, label }) => {
          const count = doc.counts[key] ?? 0;
          if (count === 0) return null;
          return (
            <span
              key={key}
              className={"verdict-slice " + key}
              style={{ flexGrow: count }}
              title={`${count} ${label}`}
            >
              {count} {label}
            </span>
          );
        })}
      </div>

      <div className="row">
        <div className="seg">
          <button type="button" onClick={() => onSelected(allPages(doc.pages))}>
            all
          </button>
          <button
            type="button"
            onClick={() => onSelected(pagesWithContent(doc.pages))}
          >
            skip blanks
          </button>
          <button type="button" onClick={() => onSelected(new Set())}>
            none
          </button>
        </div>
        <form
          className="range"
          onSubmit={(e) => {
            e.preventDefault();
            onSelected(parseRange(range, doc.pageCount));
          }}
        >
          <input value={range} placeholder="pages, e.g. 1,7-40" onChange={(e) => setRange(e.target.value)} />
          <button type="submit" className="btn ghost">
            apply
          </button>
        </form>
        <span className="count mono">
          {selected.size}/{doc.pageCount} selected
        </span>
      </div>

      <div className="page-map">
        {doc.pages.map((page) => (
          <button
            key={page.page}
            type="button"
            className={"page-cell " + page.verdict + (selected.has(page.page) ? " on" : "")}
            title={`page ${page.page} · ${page.verdict}`}
            onClick={() => onSelected(togglePage(selected, page.page))}
          >
            {page.page}
          </button>
        ))}
      </div>
    </section>
  );
}
