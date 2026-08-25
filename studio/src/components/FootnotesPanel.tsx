import { useState } from "react";
import type { Footnote, ValidationIssue } from "../api";
import { isValidId, slugify } from "../blocks";
import { Field, TextInput } from "./fields";
import { BlockList } from "./BlockList";

export function FootnotesPanel({
  footnotes,
  onChange,
  issues,
}: {
  footnotes: Record<string, Footnote>;
  onChange: (footnotes: Record<string, Footnote>) => void;
  issues: ValidationIssue[];
}) {
  const [newId, setNewId] = useState("");
  const ids = Object.keys(footnotes);

  const addFootnote = () => {
    const id = slugify(newId) || `fn-${ids.length + 1}`;
    if (!isValidId(id) || footnotes[id]) return;
    onChange({ ...footnotes, [id]: { label: String(ids.length + 1), blocks: [{ type: "text", text: "" }] } });
    setNewId("");
  };

  return (
    <div className="footnotes-panel">
      {ids.length === 0 && <p className="block-list-empty">No footnotes yet.</p>}
      {ids.map((id) => {
        const note = footnotes[id]!;
        return (
          <div key={id} className="footnote-card">
            <div className="footnote-header">
              <code>[^{id}]</code>
              <Field label="label">
                <TextInput
                  value={note.label}
                  onChange={(e) => onChange({ ...footnotes, [id]: { ...note, label: e.target.value } })}
                />
              </Field>
              <button
                type="button"
                className="btn-icon btn-danger"
                onClick={() => {
                  const next = { ...footnotes };
                  delete next[id];
                  onChange(next);
                }}
              >
                x
              </button>
            </div>
            <BlockList
              blocks={note.blocks}
              path={["footnotes", id, "blocks"]}
              issues={issues}
              onChange={(blocks) => onChange({ ...footnotes, [id]: { ...note, blocks } })}
            />
          </div>
        );
      })}
      <div className="add-footnote">
        <TextInput placeholder="new footnote id, e.g. ch2-fn7" value={newId} onChange={(e) => setNewId(e.target.value)} />
        <button type="button" className="btn-ghost" onClick={addFootnote}>
          + add footnote
        </button>
      </div>
    </div>
  );
}
