import type { Doc, TestResult } from "../api";
import { pageImage } from "../api";
import { describeBlock } from "../blocks";
import { formatDuration } from "../format";

export function TestCard({
  doc,
  page,
  onPage,
  result,
  running,
  ready,
  onRun,
  projectedMs,
}: {
  doc: Doc;
  page: number;
  onPage: (page: number) => void;
  result: TestResult | null;
  running: boolean;
  ready: boolean;
  onRun: () => void;
  projectedMs: number | null;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Try one page</h2>
          <p className="sub">
            Reads a single page for real, so you see the quality and learn how long this machine needs per page.
          </p>
        </div>
        <div className="head-actions">
          <label className="page-pick">
            page
            <input
              type="number"
              min={1}
              max={doc.pageCount}
              value={page}
              onChange={(e) => onPage(Math.min(doc.pageCount, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
          <button type="button" className="btn primary" disabled={!ready || running} onClick={onRun}>
            {running ? "reading…" : result ? "run again" : "Read this page"}
          </button>
        </div>
      </header>

      {!ready && <p className="note">Install the model above first — reading a scanned page needs it.</p>}

      {running && (
        <div className="job">
          <div className="bar">
            <div className="bar-fill indeterminate" />
          </div>
          <div className="job-meta">
            <span>Recognizing page {page}. The very first run also downloads the model weights.</span>
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="result-line">
            <strong className="mono accent">{formatDuration(result.elapsedMs)}</strong>
            <span>per scanned page on this machine</span>
            {projectedMs !== null && (
              <>
                <span className="arrow">→</span>
                <strong className="mono">{formatDuration(projectedMs)}</strong>
                <span>for the pages you selected</span>
              </>
            )}
          </div>
          <div className="test-split">
            <div className="page-shot">
              <img src={pageImage(doc.id, result.page, 1)} alt={`page ${result.page}`} />
              {result.regions.map((region, i) => (
                <span
                  key={i}
                  className="region"
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.w * 100}%`,
                    height: `${region.h * 100}%`,
                  }}
                  title={region.label}
                />
              ))}
            </div>
            <ol className="blocks">
              {result.blocks.length === 0 && <li className="dim">Nothing recognized on this page.</li>}
              {result.blocks.map((block, i) => {
                const { kind, text } = describeBlock(block);
                return (
                  <li key={i}>
                    <span className="kind">{kind}</span>
                    <span className="block-text">{text}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}
