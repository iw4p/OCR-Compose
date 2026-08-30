import { useEffect, useRef } from "react";
import type { Hardware, ModelStatus } from "../api";
import { formatBytes, formatClock } from "../format";

export function ModelCard({
  model,
  hardware,
  installing,
  log,
  elapsedMs,
  onInstall,
  onUnload,
  onRemove,
}: {
  model: ModelStatus | null;
  hardware: Hardware | null;
  installing: boolean;
  log: string[];
  elapsedMs: number;
  onInstall: () => void;
  onUnload: () => void;
  onRemove: () => void;
}) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  if (!model) return <section className="card skeleton" />;

  const download = model.runtimeDownloadBytes + model.weightsDownloadBytes;

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>
            <span className={"status-dot" + (model.installed ? (model.loaded ? " live" : " ready") : "")} />
            {model.name} <span className="dim">{model.version}</span>
          </h2>
          <p className="sub">{model.description}</p>
        </div>
        {model.installed && !installing && (
          <div className="head-actions">
            {model.loaded && (
              <button type="button" className="btn ghost" onClick={onUnload}>
                free memory
              </button>
            )}
            {model.source === "managed" && (
              <button type="button" className="btn ghost danger" onClick={onRemove}>
                uninstall
              </button>
            )}
          </div>
        )}
      </header>

      {model.installed ? (
        <dl className="stats">
          <div>
            <dt>state</dt>
            <dd>{model.loaded ? "loaded in memory" : "installed, idle"}</dd>
          </div>
          <div>
            <dt>runtime</dt>
            <dd>{model.source === "managed" ? formatBytes(model.diskBytes) : "your own environment"}</dd>
          </div>
          <div>
            <dt>weights</dt>
            <dd>
              {model.weightsDiskBytes > 0
                ? `${formatBytes(model.weightsDiskBytes)} cached`
                : `~${formatBytes(model.weightsDownloadBytes)} on first page`}
            </dd>
          </div>
          {hardware && (
            <div>
              <dt>running on</dt>
              <dd title={hardware.platform}>
                {hardware.cpu} · {hardware.cores} cores · {formatBytes(hardware.memoryBytes)}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <>
          <dl className="stats">
            <div>
              <dt>download</dt>
              <dd className="accent">≈ {formatBytes(download)}</dd>
            </div>
            <div>
              <dt>python runtime</dt>
              <dd>≈ {formatBytes(model.runtimeDownloadBytes)}</dd>
            </div>
            <div>
              <dt>model weights</dt>
              <dd>≈ {formatBytes(model.weightsDownloadBytes)}, on first use</dd>
            </div>
            {hardware && (
              <div>
                <dt>this machine</dt>
                <dd title={hardware.platform}>
                  {hardware.cpu} · {hardware.cores} cores
                </dd>
              </div>
            )}
          </dl>
          {!installing && (
            <button type="button" className="btn primary" onClick={onInstall}>
              Install PaddleOCR-VL
            </button>
          )}
        </>
      )}

      {installing && (
        <div className="job">
          <div className="bar">
            <div className="bar-fill indeterminate" />
          </div>
          <div className="job-meta">
            <span>Installing — this takes a few minutes</span>
            <span className="mono">{formatClock(elapsedMs)}</span>
          </div>
          <pre className="log" ref={logRef}>
            {log.slice(-200).join("\n")}
          </pre>
        </div>
      )}
    </section>
  );
}
