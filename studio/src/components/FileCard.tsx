import { useRef, useState } from "react";
import type { Doc } from "../api";
import { formatBytes } from "../format";

/** `1,3-5,9` → page numbers inside the document. Junk is ignored, not fatal. */
function parseRange(input: string, max: number): Set<number> {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) continue;
    for (let n = Number(match[1]); n <= Number(match[2] ?? match[1]); n++) if (n >= 1 && n <= max) pages.add(n);
  }
  return pages;
}

export function Dropzone({ onFile, busy }: { onFile: (file: File) => void; busy: boolean }) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      className={"dropzone" + (dragging ? " dragging" : "") + (busy ? " busy" : "")}
      onClick={() => !busy && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file && !busy) onFile(file);
      }}
    >
      <input
        ref={input}
        type="file"
        accept=".pdf,application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <strong>{busy ? "Reading the PDF…" : "Drop a PDF here"}</strong>
      <span className="sub">{busy ? "counting pages and checking each one for real text" : "or click to choose one · up to 512 MB"}</span>
    </div>
  );
}

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

  const toggle = (page: number) => {
    const next = new Set(selected);
    if (!next.delete(page)) next.add(page);
    onSelected(next);
  };

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
          <button type="button" onClick={() => onSelected(new Set(doc.pages.map((p) => p.page)))}>
            all
          </button>
          <button
            type="button"
            onClick={() => onSelected(new Set(doc.pages.filter((p) => p.verdict !== "no-text").map((p) => p.page)))}
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
            onClick={() => toggle(page.page)}
          >
            {page.page}
          </button>
        ))}
      </div>
    </section>
  );
}
