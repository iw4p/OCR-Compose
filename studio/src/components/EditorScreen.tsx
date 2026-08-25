import { useMemo, useState } from "react";
import type { Book, ValidationIssue } from "../api";
import { BlockList } from "./BlockList";
import { FootnotesPanel } from "./FootnotesPanel";
import { Field, TextInput } from "./fields";
import { DocumentProvider } from "../context";

export function EditorScreen({
  book,
  onChange,
  documentId,
  conversionId,
  issues,
  validated,
  onValidate,
  onExportEpub,
  onDownloadJson,
  validating,
  exporting,
}: {
  book: Book;
  onChange: (book: Book) => void;
  documentId: string;
  conversionId?: string;
  issues: ValidationIssue[];
  validated: boolean;
  onValidate: () => void;
  onExportEpub: () => void;
  onDownloadJson: () => void;
  validating: boolean;
  exporting: boolean;
}) {
  const [tab, setTab] = useState<"content" | "footnotes">("content");
  const headings = useMemo(
    () => book.content.map((b, i) => ({ i, b })).filter(({ b }) => b.type === "heading"),
    [book.content],
  );

  return (
    <DocumentProvider value={{ documentId, conversionId }}>
      <div className="editor-screen">
        <aside className="editor-outline">
          <h3>Outline</h3>
          <nav>
            {headings.length === 0 && <p className="muted">No headings yet.</p>}
            {headings.map(({ i, b }) => (
              <button
                key={i}
                type="button"
                className="outline-item"
                style={{ paddingLeft: `${(b.type === "heading" ? b.level : 1) * 10}px` }}
                onClick={() => document.getElementById(`b-content-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {b.type === "heading" ? b.text || "(untitled)" : ""}
              </button>
            ))}
          </nav>
          <h3>Validation</h3>
          <button type="button" className="btn-secondary" onClick={onValidate} disabled={validating}>
            {validating ? "checking..." : "validate"}
          </button>
          {issues.length === 0 ? (
            <p className={"muted" + (validated ? " status-ready" : "")}>
              {validated ? "Valid — no issues." : "Not yet validated. Run validate."}
            </p>
          ) : (
            <ul className="issue-list global">
              {issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.path.join(".")}</code>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="editor-export">
            <button type="button" className="btn-primary" onClick={onExportEpub} disabled={exporting}>
              {exporting ? "exporting..." : "Export EPUB"}
            </button>
            <button type="button" className="btn-ghost" onClick={onDownloadJson}>
              Download book.json
            </button>
          </div>
        </aside>

        <main className="editor-main">
          <div className="book-meta">
            <Field label="title">
              <TextInput value={book.title} onChange={(e) => onChange({ ...book, title: e.target.value })} />
            </Field>
            <Field label="author">
              <TextInput value={book.author ?? ""} onChange={(e) => onChange({ ...book, author: e.target.value || undefined })} />
            </Field>
            <Field label="language">
              <TextInput value={book.language} onChange={(e) => onChange({ ...book, language: e.target.value })} />
            </Field>
            <Field label="cover asset">
              <TextInput value={book.cover ?? ""} onChange={(e) => onChange({ ...book, cover: e.target.value || undefined })} />
            </Field>
          </div>

          <div className="editor-tabs">
            <button type="button" className={tab === "content" ? "active" : ""} onClick={() => setTab("content")}>
              Content ({book.content.length})
            </button>
            <button type="button" className={tab === "footnotes" ? "active" : ""} onClick={() => setTab("footnotes")}>
              Footnotes ({Object.keys(book.footnotes).length})
            </button>
          </div>

          {tab === "content" ? (
            <BlockList blocks={book.content} path={["content"]} issues={issues} onChange={(content) => onChange({ ...book, content })} />
          ) : (
            <FootnotesPanel footnotes={book.footnotes} issues={issues} onChange={(footnotes) => onChange({ ...book, footnotes })} />
          )}
        </main>
      </div>
    </DocumentProvider>
  );
}
