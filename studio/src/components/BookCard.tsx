import { useState } from "react";
import type { Block, Book } from "../api";
import { assetUrl } from "../api";
import { InlineText } from "./InlineText";

/**
 * The converted book, readable and correctable in place. Every block can be
 * moved or removed; the ones that carry a single text (paragraphs, headings,
 * quotes, formula TeX, image captions) can be edited as the dialect source.
 * Each change goes through the server's validation and re-packs the EPUB, so
 * the download always matches what this card shows.
 */
export function BookCard({
  docId,
  book,
  busy,
  onBook,
}: {
  docId: string;
  book: Book;
  busy: boolean;
  onBook: (book: Book) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const replace = (at: number, block: Block | null) => {
    const content = [...book.content];
    if (block) content[at] = block;
    else content.splice(at, 1);
    onBook({ ...book, content });
  };

  const move = (at: number, delta: -1 | 1) => {
    const to = at + delta;
    if (to < 0 || to >= book.content.length) return;
    const content = [...book.content];
    [content[at], content[to]] = [content[to]!, content[at]!];
    onBook({ ...book, content });
  };

  const startEdit = (at: number) => {
    setEditing(at);
    setDraft(editableText(book.content[at]!) ?? "");
  };

  const saveEdit = () => {
    if (editing === null) return;
    const edited = withText(book.content[editing]!, draft);
    setEditing(null);
    if (edited) replace(editing, edited);
  };

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Review</h2>
          <p className="sub">
            The book as the EPUB will read it — {book.content.length} blocks. Hover a block to fix, move or
            remove it; every change is validated and the downloads update.
          </p>
        </div>
      </header>

      <div className="book-view">
        {book.content.map((block, at) => (
          <div key={at} className={"book-block" + (isDim(block) ? " dimmed" : "")}>
            <div className="book-block-body">{editing === at ? null : <BlockView docId={docId} block={block} />}</div>
            {editing === at ? (
              <div className="book-edit">
                <textarea
                  value={draft}
                  rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 80)))}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
                <div className="book-edit-actions">
                  <button type="button" className="btn primary" onClick={saveEdit} disabled={busy}>
                    save
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                    cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="book-tools" aria-label={`block ${at + 1} tools`}>
                <button type="button" title="move up" disabled={busy || at === 0} onClick={() => move(at, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  title="move down"
                  disabled={busy || at === book.content.length - 1}
                  onClick={() => move(at, 1)}
                >
                  ↓
                </button>
                {editableText(block) !== null && (
                  <button type="button" title="edit" disabled={busy} onClick={() => startEdit(at)}>
                    ✎
                  </button>
                )}
                <button type="button" title="remove" className="danger" disabled={busy} onClick={() => replace(at, null)}>
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The one editable string a block carries, or `null` when there is none. */
const editableText = (block: Block): string | null => {
  switch (block.type) {
    case "heading":
    case "text":
    case "quote":
      return block.text;
    case "formula":
      return block.tex;
    case "image":
      return block.caption ?? "";
    default:
      return null;
  }
};

/** That string, written back — the inverse of `editableText`. */
const withText = (block: Block, draft: string): Block | null => {
  switch (block.type) {
    case "heading":
    case "text":
    case "quote":
      return { ...block, text: draft };
    case "formula":
      return { ...block, tex: draft };
    case "image": {
      const { caption: _caption, ...rest } = block;
      return draft.trim() === "" ? rest : { ...rest, caption: draft };
    }
    default:
      return null;
  }
};

const DIM_ROLES = new Set(["running-header", "running-footer", "page-number", "artifact", "footnote-source", "table-source"]);
const isDim = (block: Block) => block.role !== undefined && DIM_ROLES.has(block.role);

function BlockView({ docId, block }: { docId: string; block: Block }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(4, Math.max(1, block.level + 1))}`) as "h2";
      return (
        <Tag className="book-heading">
          <InlineText text={block.text} />
        </Tag>
      );
    }
    case "text":
      return (
        <p className={block.role === "caption" ? "book-caption" : undefined}>
          {block.role && block.role !== "caption" && <span className="kind">{block.role}</span>}
          <InlineText text={block.text} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <InlineText text={block.text} />
          {block.attribution && <footer>— {block.attribution}</footer>}
        </blockquote>
      );
    case "image":
      return (
        <figure>
          <img src={assetUrl(docId, block.file)} alt={block.alt ?? block.caption ?? ""} loading="lazy" />
          {block.caption && (
            <figcaption className="book-caption">
              <InlineText text={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "table":
      return block.rows ? (
        <div className="book-table">
          <table>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <InlineText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : block.image ? (
        <figure>
          <img src={assetUrl(docId, block.image)} alt={block.caption ?? "table"} loading="lazy" />
        </figure>
      ) : (
        <p className="dim">table kept as an image</p>
      );
    case "formula":
      return block.tex !== null ? (
        <p className="book-formula">
          <code className="tex">{block.tex}</code>
          {block.number && <span className="dim"> ({block.number})</span>}
        </p>
      ) : block.image ? (
        <figure>
          <img src={assetUrl(docId, block.image)} alt="formula" loading="lazy" />
        </figure>
      ) : (
        <p className="dim">formula kept as an image</p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag>
          {block.items.map((item, i) => (
            <li key={i}>
              {item.map((inner, j) => (
                <BlockView key={j} docId={docId} block={inner} />
              ))}
            </li>
          ))}
        </Tag>
      );
    }
  }
}
