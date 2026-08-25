import { useState } from "react";
import type { Block, ValidationIssue } from "../api";
import { BLOCK_LABELS, blockPreview, isValidId, suggestId, keyOf, carryKey } from "../blocks";
import { Field, TextArea, TextInput } from "./fields";
import { AssetImage } from "./AssetImage";
import { BlockList } from "./BlockList";
import { useDocumentContext } from "../context";

const pathMatches = (issuePath: (string | number)[], ownPath: (string | number)[]) =>
  ownPath.every((segment, i) => issuePath[i] === segment);

const pageLabel = (block: Block): string | null => {
  if (block.page !== undefined) return `page ${block.page}`;
  if (block.pages) return block.pages.map((p) => (p.at === undefined ? `${p.page}` : `${p.page}@${p.at}`)).join(" -> ");
  return null;
};

export function BlockCard({
  block,
  path,
  issues,
  onChange,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  block: Block;
  path: (string | number)[];
  issues: ValidationIssue[];
  onChange: (block: Block) => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { documentId, conversionId } = useDocumentContext();

  const own = issues.filter((i) => pathMatches(i.path, path));
  const ownDirect = own.filter((i) => i.path.length <= path.length + 1);
  const badge = block.type === "heading" ? `H${block.level}` : BLOCK_LABELS[block.type];

  return (
    <div className={"block-card" + (own.length > 0 ? " has-issue" : "")}>
      <div className="block-header">
        <span className="drag-handle" title="drag to reorder">
          ::
        </span>
        <button type="button" className="block-toggle" onClick={() => setExpanded((v) => !v)}>
          <span className={"chip chip-" + block.type}>{badge}</span>
          <span className="block-preview">{blockPreview(block)}</span>
          {own.length > 0 && <span className="issue-dot" title={`${own.length} issue(s) in this block`} />}
        </button>
        <div className="block-actions">
          <button type="button" className="btn-icon" disabled={!canMoveUp} onClick={() => onMove(-1)} title="move up">
            ^
          </button>
          <button type="button" className="btn-icon" disabled={!canMoveDown} onClick={() => onMove(1)} title="move down">
            v
          </button>
          <button type="button" className="btn-icon btn-danger" onClick={onDelete} title="remove block">
            x
          </button>
        </div>
      </div>

      {ownDirect.length > 0 && (
        <ul className="issue-list">
          {ownDirect.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="block-body">
          {block.type === "heading" && (
            <>
              <Field label="level">
                <select
                  value={block.level}
                  onChange={(e) => onChange({ ...block, level: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="text">
                <TextArea value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
              </Field>
            </>
          )}

          {block.type === "text" && (
            <Field label="text">
              <TextArea rows={4} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
            </Field>
          )}

          {block.type === "quote" && (
            <>
              <Field label="text">
                <TextArea value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
              </Field>
              <Field label="attribution">
                <TextInput
                  value={block.attribution ?? ""}
                  onChange={(e) => onChange({ ...block, attribution: e.target.value || undefined })}
                />
              </Field>
            </>
          )}

          {block.type === "image" && (
            <>
              <Field label="file" hint="path into assets/, must already exist in this book">
                <TextInput value={block.file} onChange={(e) => onChange({ ...block, file: e.target.value })} />
              </Field>
              <Field label="caption">
                <TextInput
                  value={block.caption ?? ""}
                  onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })}
                />
              </Field>
              <Field label="alt text">
                <TextInput
                  value={block.alt ?? ""}
                  onChange={(e) => onChange({ ...block, alt: e.target.value || undefined })}
                />
              </Field>
              <AssetImage documentId={documentId} conversionId={conversionId} file={block.file} alt={block.alt} />
            </>
          )}

          {block.type === "table" && (
            <TableEditor block={block} onChange={onChange} documentId={documentId} conversionId={conversionId} />
          )}

          {block.type === "formula" && (
            <>
              <Field label="display (own line)">
                <input
                  type="checkbox"
                  checked={block.display}
                  onChange={(e) => onChange({ ...block, display: e.target.checked })}
                />
              </Field>
              <Field label="tex transcribed" hint="unchecked = degrades to image only, per DESIGN.md fidelity levels">
                <input
                  type="checkbox"
                  checked={block.tex !== null}
                  onChange={(e) => onChange({ ...block, tex: e.target.checked ? "" : null })}
                />
              </Field>
              {block.tex !== null && (
                <Field label="tex">
                  <TextArea value={block.tex} onChange={(e) => onChange({ ...block, tex: e.target.value })} />
                </Field>
              )}
              <Field label="number">
                <TextInput
                  value={block.number ?? ""}
                  onChange={(e) => onChange({ ...block, number: e.target.value || undefined })}
                />
              </Field>
              <Field label="image fallback">
                <TextInput
                  value={block.image ?? ""}
                  onChange={(e) => onChange({ ...block, image: e.target.value || undefined })}
                />
              </Field>
              {block.image && <AssetImage documentId={documentId} conversionId={conversionId} file={block.image} />}
            </>
          )}

          {block.type === "list" && (
            <>
              <Field label="ordered">
                <input
                  type="checkbox"
                  checked={block.ordered}
                  onChange={(e) => onChange({ ...block, ordered: e.target.checked })}
                />
              </Field>
              <div className="list-items">
                {block.items.map((item, i) => (
                  <div key={keyOf(item)} className="list-item">
                    <div className="list-item-header">
                      <span>item {i + 1}</span>
                      <div className="block-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={i === 0}
                          onClick={() => {
                            const items = block.items.slice();
                            [items[i - 1], items[i]] = [items[i]!, items[i - 1]!];
                            onChange({ ...block, items });
                          }}
                        >
                          ^
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={i === block.items.length - 1}
                          onClick={() => {
                            const items = block.items.slice();
                            [items[i + 1], items[i]] = [items[i]!, items[i + 1]!];
                            onChange({ ...block, items });
                          }}
                        >
                          v
                        </button>
                        <button
                          type="button"
                          className="btn-icon btn-danger"
                          onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                        >
                          x
                        </button>
                      </div>
                    </div>
                    <BlockList
                      blocks={item}
                      path={[...path, "items", i]}
                      issues={own}
                      onChange={(next) => {
                        const items = block.items.slice();
                        items[i] = carryKey(item, next);
                        onChange({ ...block, items });
                      }}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onChange({ ...block, items: [...block.items, [{ type: "text", text: "" }]] })}
              >
                + add item
              </button>
            </>
          )}

          <button type="button" className="btn-ghost btn-small" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "hide" : "show"} id / role / provenance
          </button>
          {showAdvanced && (
            <div className="advanced-fields">
              <Field label="id" hint={block.id && !isValidId(block.id) ? "must be lowercase kebab-case" : undefined}>
                <div className="id-row">
                  <TextInput value={block.id ?? ""} onChange={(e) => onChange({ ...block, id: e.target.value || undefined })} />
                  <button type="button" className="btn-ghost btn-small" onClick={() => onChange({ ...block, id: suggestId(block, new Set()) })}>
                    suggest
                  </button>
                </div>
              </Field>
              <Field label="role" hint="running-header / page-number / artifact demote emitters skip">
                <TextInput value={block.role ?? ""} onChange={(e) => onChange({ ...block, role: e.target.value || undefined })} />
              </Field>
              <Field label="language">
                <TextInput value={block.language ?? ""} onChange={(e) => onChange({ ...block, language: e.target.value || undefined })} />
              </Field>
              {pageLabel(block) && (
                <Field label="page provenance" hint="read-only: recorded at extraction time">
                  <span className="readonly-value">{pageLabel(block)}</span>
                </Field>
              )}
              {block.annotations && block.annotations.length > 0 && (
                <Field label="annotations" hint="read-only in this build: edit text and matches together by hand, or via `bookforge fix-offsets`">
                  <ul className="readonly-list">
                    {block.annotations.map((a, i) => (
                      <li key={i}>
                        [{a.start},{a.end}) &quot;{a.matches}&quot;{a.language ? ` (${a.language})` : ""}
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TableEditor({
  block,
  onChange,
  documentId,
  conversionId,
}: {
  block: Extract<Block, { type: "table" }>;
  onChange: (block: Block) => void;
  documentId: string;
  conversionId?: string;
}) {
  const cols = block.rows?.[0]?.length ?? 0;
  return (
    <>
      <Field label="caption">
        <TextInput value={block.caption ?? ""} onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })} />
      </Field>
      <Field label="rows parsed" hint="off = degrades to the image below, per DESIGN.md fidelity levels">
        <input
          type="checkbox"
          checked={block.rows !== null}
          onChange={(e) => onChange({ ...block, rows: e.target.checked ? [["", ""]] : null })}
        />
      </Field>
      {block.rows !== null && (
        <div className="table-editor">
          <table>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <input
                        value={cell}
                        onChange={(e) => {
                          const rows = block.rows!.map((rr) => rr.slice());
                          rows[r]![c] = e.target.value;
                          onChange({ ...block, rows });
                        }}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="btn-icon btn-danger" onClick={() => onChange({ ...block, rows: block.rows!.filter((_, i) => i !== r) })}>
                      x
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-actions">
            <button
              type="button"
              className="btn-ghost btn-small"
              onClick={() => onChange({ ...block, rows: [...block.rows!, Array.from({ length: cols || 1 }, () => "")] })}
            >
              + row
            </button>
            <button
              type="button"
              className="btn-ghost btn-small"
              onClick={() => onChange({ ...block, rows: block.rows!.map((row) => [...row, ""]) })}
            >
              + column
            </button>
          </div>
        </div>
      )}
      {block.image && (
        <>
          <Field label="image fallback">
            <TextInput value={block.image} onChange={(e) => onChange({ ...block, image: e.target.value })} />
          </Field>
          <AssetImage documentId={documentId} conversionId={conversionId} file={block.image} />
        </>
      )}
    </>
  );
}
