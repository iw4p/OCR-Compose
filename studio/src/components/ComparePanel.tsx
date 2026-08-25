import { useState } from "react";
import type { CompareResult } from "../api";
import { PagePreview } from "./PagePreview";

export function ComparePanel({
  documentId,
  samplePage,
  results,
  comparing,
  onRun,
  canRun,
  convertModelId,
  onChooseConvertModel,
}: {
  documentId: string;
  samplePage: number | null;
  results: CompareResult[];
  comparing: boolean;
  onRun: () => void;
  canRun: boolean;
  convertModelId: string | null;
  onChooseConvertModel: (id: string) => void;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const active = results.find((r) => r.modelId === focused) ?? results[0];

  return (
    <div className="compare-panel">
      <button type="button" className="btn-primary" disabled={!canRun || comparing} onClick={onRun}>
        {comparing ? "running comparison..." : `Compare on page ${samplePage ?? "?"}`}
      </button>

      {results.length > 0 && (
        <>
          <table className="compare-table">
            <thead>
              <tr>
                <th>model</th>
                <th>time</th>
                <th>blocks</th>
                <th>use for convert</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.modelId} className={active?.modelId === r.modelId ? "active" : ""} onClick={() => setFocused(r.modelId)}>
                  <td>{r.modelId}</td>
                  <td>{r.ok ? `${r.elapsedMs}ms` : <span className="status-error">failed</span>}</td>
                  <td>{r.ok ? r.blocks?.length ?? 0 : r.error}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="radio"
                      name="convert-model"
                      checked={convertModelId === r.modelId}
                      disabled={!r.ok}
                      onChange={() => onChooseConvertModel(r.modelId)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {active?.ok && samplePage !== null && (
            <div className="compare-detail">
              <PagePreview documentId={documentId} page={samplePage} blocks={active.blocks} />
              <ol className="contract-blocks">
                {active.contractBlocks?.map((b, i) => (
                  <li key={i}>
                    <code>{(b as { type: string }).type}</code> {JSON.stringify(b).slice(0, 140)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
