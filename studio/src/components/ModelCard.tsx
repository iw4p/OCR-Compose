import { useEffect, useRef, useState } from "react";
import type { Hardware, ModelStatus } from "../api";
import { formatBytes, formatClock } from "../format";

/** One labelled figure. Every number in this card is measured, not assumed. */
const Stat = ({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) => (
  <div>
    <dt>{label}</dt>
    <dd title={title}>{children}</dd>
  </div>
);

/** What it will cost to get the model, before committing to the download. */
function InstallOffer({ model, hardware, onInstall }: { model: ModelStatus; hardware: Hardware | null; onInstall: () => void }) {
  return (
    <>
      <dl className="stats">
        <Stat label="download">
          <span className="accent">≈ {formatBytes(model.runtimeDownloadBytes + model.weightsDownloadBytes)}</span>
        </Stat>
        <Stat label="python runtime">≈ {formatBytes(model.runtimeDownloadBytes)}</Stat>
        <Stat label="model weights">≈ {formatBytes(model.weightsDownloadBytes)}, on first use</Stat>
        {hardware && (
          <Stat label="this machine" title={hardware.platform}>
            {hardware.cpu} · {hardware.cores} cores
          </Stat>
        )}
      </dl>
      <button type="button" className="btn primary" onClick={onInstall}>
        Install {model.name}
      </button>
    </>
  );
}

/** What is on this machine now, and what it will run on. */
function InstalledModel({ model, hardware }: { model: ModelStatus; hardware: Hardware | null }) {
  return (
    <dl className="stats">
      <Stat label="state">{model.loaded ? "loaded in memory" : "installed, idle"}</Stat>
      <Stat label="runtime">{model.source === "managed" ? formatBytes(model.diskBytes) : "your own environment"}</Stat>
      <Stat label="weights">
        {model.weightsDiskBytes > 0
          ? `${formatBytes(model.weightsDiskBytes)} cached`
          : `~${formatBytes(model.weightsDownloadBytes)} on first page`}
      </Stat>
      {hardware && (
        <Stat label="running on" title={hardware.platform}>
          {hardware.cpu} · {hardware.cores} cores · {formatBytes(hardware.memoryBytes)}
        </Stat>
      )}
    </dl>
  );
}

/** pip's own output, live, because this takes minutes and silence is worse. */
function InstallProgress({ log, elapsedMs }: { log: string[]; elapsedMs: number }) {
  const view = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (view.current) view.current.scrollTop = view.current.scrollHeight; // follow the tail
  }, [log]);

  return (
    <div className="job">
      <div className="bar">
        <div className="bar-fill indeterminate" />
      </div>
      <div className="job-meta">
        <span>Installing — this takes a few minutes</span>
        <span className="mono">{formatClock(elapsedMs)}</span>
      </div>
      <pre className="log" ref={view}>
        {log.slice(-200).join("\n")}
      </pre>
    </div>
  );
}

/** Deleting gigabytes that take minutes to fetch again is never one click. */
function ModelActions({ model, onUnload, onRemove }: { model: ModelStatus; onUnload: () => void; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="head-actions">
      {model.loaded && (
        <button type="button" className="btn ghost" onClick={onUnload}>
          free memory
        </button>
      )}
      {model.source !== "managed" ? null : confirming ? (
        <>
          <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
            keep it
          </button>
          <button
            type="button"
            className="btn ghost danger"
            onClick={() => {
              setConfirming(false);
              onRemove();
            }}
          >
            delete {formatBytes(model.diskBytes)} from disk
          </button>
        </>
      ) : (
        <button type="button" className="btn ghost danger" onClick={() => setConfirming(true)}>
          uninstall
        </button>
      )}
    </div>
  );
}

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
  if (!model) return <section className="card skeleton" />;

  const dot = model.installed ? (model.loaded ? " live" : " ready") : "";

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>
            <span className={"status-dot" + dot} />
            {model.name} <span className="dim">{model.version}</span>
          </h2>
          <p className="sub">{model.description}</p>
        </div>
        {model.installed && !installing && <ModelActions model={model} onUnload={onUnload} onRemove={onRemove} />}
      </header>

      {model.installed ? (
        <InstalledModel model={model} hardware={hardware} />
      ) : (
        !installing && <InstallOffer model={model} hardware={hardware} onInstall={onInstall} />
      )}

      {installing && <InstallProgress log={log} elapsedMs={elapsedMs} />}
    </section>
  );
}
