import { useState } from "react";
import type { ModelAction, ModelInfo } from "../api";

const onDisk = (bytes: number) => {
  if (bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value.toFixed(value < 10 && power > 0 ? 1 : 0)} ${units[power]}`;
};

export function ModelCatalog({
  models,
  selected,
  onToggle,
  onAction,
  pending,
  convertModelId,
  onChooseConvertModel,
}: {
  models: ModelInfo[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onAction: (id: string, action: ModelAction) => void;
  pending: Set<string>;
  convertModelId: string | null;
  onChooseConvertModel: (id: string) => void;
}) {
  // Removal is irreversible, so it is always a two-click confirmation.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  return (
    <div className="model-catalog">
      {models.length === 0 && <p className="muted">No model providers registered.</p>}
      {models.map((model) => {
        const busy = pending.has(model.id);
        const size = onDisk(model.diskBytes);
        return (
          <div key={model.id} className="model-card">
            <label className="model-card-select">
              <input
                type="checkbox"
                title="compare this model"
                checked={selected.has(model.id)}
                onChange={() => onToggle(model.id)}
                disabled={!model.installed}
              />
              <div>
                <div className="model-card-title">
                  {model.name} <span className="muted">{model.version}</span>
                  {model.loaded && <span className="chip chip-loaded">loaded</span>}
                </div>
                <p className="model-card-desc">{model.description}</p>
                <div className="model-card-caps">
                  {model.capabilities.map((c) => (
                    <span key={c} className="chip chip-cap">
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </label>

            {model.installed ? (
              <div className="model-card-status">
                <span className="muted small">
                  {model.source === "managed" ? `${size ?? "0 B"} on disk` : "runtime provided by your environment"}
                </span>
                <span className="model-card-actions">
                  {/* Two questions, not one: what to compare, and what to convert with. */}
                  <label className="model-card-convert">
                    <input
                      type="radio"
                      // its own group: a browser lets one radio per name be
                      // checked, and the compare table shows the same choice
                      name="convert-model-card"
                      checked={convertModelId === model.id}
                      onChange={() => onChooseConvertModel(model.id)}
                    />
                    convert with this
                  </label>
                  <button type="button" className="btn-ghost btn-small" disabled={busy || !model.loaded} onClick={() => onAction(model.id, "unload")}>
                    unload
                  </button>
                  {model.source === "managed" && (
                    <button type="button" className="btn-ghost btn-small btn-danger" disabled={busy} onClick={() => setConfirmRemove(model.id)}>
                      remove
                    </button>
                  )}
                </span>
              </div>
            ) : (
              <div className="model-card-status">
                <span className="muted small">not installed</span>
                <button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => onAction(model.id, "install")}>
                  {busy ? "installing..." : model.installLabel}
                </button>
              </div>
            )}

            {confirmRemove === model.id ? (
              <div className="model-card-confirm">
                <p className="status-error small">
                  Delete the {size ?? "managed"} runtime in <code>.bookforge-models/{model.id}/</code>? This cannot be undone; reinstalling
                  downloads it again.
                </p>
                <div className="model-card-actions">
                  <button type="button" className="btn-ghost btn-small" onClick={() => setConfirmRemove(null)}>
                    cancel
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-small btn-danger"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRemove(null);
                      onAction(model.id, "remove");
                    }}
                  >
                    delete from disk
                  </button>
                </div>
              </div>
            ) : (
              model.installed && <p className="muted small">{model.firstRunNote}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
