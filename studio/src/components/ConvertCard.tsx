import type { ConvertStats, Doc } from "../api";
import { downloadUrl } from "../api";
import type { Estimate } from "../estimate";
import { formatBytes, formatClock, formatDuration } from "../format";

export type Meta = { title: string; author: string; language: string };
export type Job = { stage: string; done: number; total: number; elapsedMs: number };

export function ConvertCard({
  doc,
  meta,
  onMeta,
  estimate,
  ready,
  blocked,
  job,
  stats,
  warnings,
  onConvert,
}: {
  doc: Doc;
  meta: Meta;
  onMeta: (meta: Meta) => void;
  estimate: Estimate;
  ready: boolean;
  blocked: string | null;
  job: Job | null;
  stats: ConvertStats | null;
  warnings: string[];
  onConvert: () => void;
}) {
  // Once pages start finishing, the machine's own rate beats the projection.
  const measured = job && job.done > 0 ? (job.elapsedMs / job.done) * (job.total - job.done) : null;
  const remaining = measured ?? (estimate.totalMs !== null && job ? Math.max(0, estimate.totalMs - job.elapsedMs) : null);
  const fraction = job && job.total > 0 ? job.done / job.total : null;

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Convert</h2>
          <p className="sub">
            {estimate.selected} pages — {estimate.scanned} scanned, {estimate.native} native, {estimate.blank} blank.
          </p>
        </div>
        {estimate.totalMs !== null && !job && !stats && (
          <div className="eta">
            <span className="dim">estimated</span>
            <strong className="mono accent">{formatDuration(estimate.totalMs)}</strong>
          </div>
        )}
      </header>

      <div className="fields">
        <label>
          title
          <input value={meta.title} onChange={(e) => onMeta({ ...meta, title: e.target.value })} />
        </label>
        <label>
          author
          <input value={meta.author} onChange={(e) => onMeta({ ...meta, author: e.target.value })} />
        </label>
        <label className="narrow">
          language
          <input value={meta.language} onChange={(e) => onMeta({ ...meta, language: e.target.value })} />
        </label>
      </div>

      {blocked && <p className="note">{blocked}</p>}

      {!job && (
        <button type="button" className="btn primary big" disabled={!ready} onClick={onConvert}>
          {stats ? "Convert again" : `Convert ${estimate.selected} page${estimate.selected === 1 ? "" : "s"} to EPUB`}
        </button>
      )}

      {job && (
        <div className="job">
          <div className="bar">
            <div
              className={"bar-fill" + (fraction === null ? " indeterminate" : "")}
              style={fraction === null ? undefined : { width: `${Math.max(2, fraction * 100)}%` }}
            />
          </div>
          <div className="job-meta">
            <span>
              {job.stage}
              {job.total > 0 && (
                <>
                  {" "}
                  <span className="mono">
                    {job.done}/{job.total}
                  </span>
                </>
              )}
            </span>
            <span className="mono">
              {formatClock(job.elapsedMs)}
              {remaining !== null && ` · ${formatDuration(remaining)} left`}
            </span>
          </div>
        </div>
      )}

      {stats && !job && (
        <div className="done">
          <dl className="stats">
            <div>
              <dt>blocks</dt>
              <dd>{stats.blocks}</dd>
            </div>
            <div>
              <dt>footnotes</dt>
              <dd>{stats.footnotes}</dd>
            </div>
            <div>
              <dt>epub size</dt>
              <dd>{formatBytes(stats.epubBytes)}</dd>
            </div>
          </dl>
          <div className="downloads">
            <a className="btn primary" href={downloadUrl(doc.id, "epub")} download>
              Download EPUB
            </a>
            <a className="btn ghost" href={downloadUrl(doc.id, "book.json")} download>
              book.json
            </a>
          </div>
          {warnings.length > 0 && (
            <details className="warnings">
              <summary>
                {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </summary>
              <ul>
                {warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
