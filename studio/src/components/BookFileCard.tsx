import type { Book, Doc } from "../api";
import { downloadUrl } from "../api";
import { formatBytes } from "../format";

/**
 * The file card for an uploaded book (an EPUB, or a book.json): there are no
 * pages to classify and nothing to convert — it exists to be reviewed below
 * and downloaded again. (A book.json referencing images it cannot carry is
 * refused at upload, so everything that reaches this card packs cleanly.)
 */
export function BookFileCard({ doc, book, onReset }: { doc: Doc; book: Book | null; onReset: () => void }) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>{doc.name}</h2>
          <p className="sub">
            {formatBytes(doc.sizeBytes)} · {book ? `${book.content.length} blocks` : "…"} — an editable book. Review
            it below; the downloads always match what the review shows.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="btn ghost" onClick={onReset}>
            different file
          </button>
        </div>
      </header>
      <div className="downloads">
        <a className="btn primary" href={downloadUrl(doc.id, "epub")} download>
          Download EPUB
        </a>
        <a className="btn ghost" href={downloadUrl(doc.id, "book.json")} download>
          book.json
        </a>
      </div>
    </section>
  );
}
