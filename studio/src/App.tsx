import { useEffect, useState } from "react";
import * as api from "./api";
import type { ConvertStats, Doc, Hardware, ModelStatus, TestResult } from "./api";
import { estimate } from "./estimate";
import { ModelCard } from "./components/ModelCard";
import { Dropzone } from "./components/Dropzone";
import { FileCard } from "./components/FileCard";
import { TestCard } from "./components/TestCard";
import { ConvertCard, type Job, type Meta } from "./components/ConvertCard";

/** A clock that only runs while something long is happening. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now()); // else the first tick reads a clock left over from the last job
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

export default function App() {
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);

  const [doc, setDoc] = useState<Doc | null>(null);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [meta, setMeta] = useState<Meta>({ title: "", author: "", language: "en" });

  const [testPage, setTestPage] = useState(1);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [job, setJob] = useState<Omit<Job, "elapsedMs"> | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const [stats, setStats] = useState<ConvertStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [error, setError] = useState<string | null>(null);

  const installElapsed = useElapsed(installStartedAt);
  const jobElapsed = useElapsed(jobStartedAt);

  const refresh = () =>
    api.getStatus().then(
      (status) => {
        setModel(status.model);
        setHardware(status.hardware);
      },
      (e) => fail(e),
    );

  useEffect(() => {
    void refresh();
  }, []);

  function fail(problem: unknown) {
    setError(problem instanceof Error ? problem.message : String(problem));
  }

  async function install() {
    setInstallLog([]);
    setInstallStartedAt(Date.now());
    setError(null);
    try {
      for await (const event of api.installModel()) {
        if (event.type === "log") setInstallLog((lines) => [...lines, event.line]);
        else if (event.type === "error") fail(event.message);
        else if (event.type === "done" && event.message) setInstallLog((lines) => [...lines, event.message!]);
      }
    } catch (e) {
      fail(e);
    } finally {
      setInstallStartedAt(null);
      void refresh();
    }
  }

  async function modelAction(action: "unload" | "remove") {
    try {
      setModel((await api.modelAction(action)).model);
    } catch (e) {
      fail(e);
    }
  }

  /** Nothing measured about one document may survive into the next. */
  function forgetDocument() {
    setDoc(null);
    setSelected(new Set());
    setTestResult(null);
    setStats(null);
    setWarnings([]);
  }

  async function addFile(file: File) {
    setReading(true);
    setError(null);
    forgetDocument();
    try {
      const added = await api.addDocument(file);
      setDoc(added);
      setSelected(new Set(added.pages.filter((page) => page.verdict !== "no-text").map((page) => page.page)));
      setMeta({ title: added.title, author: added.author, language: "en" });
      setTestPage(added.suggestedPage);
    } catch (e) {
      fail(e);
    } finally {
      setReading(false);
    }
  }

  async function runTest() {
    if (!doc) return;
    setTesting(true);
    setError(null);
    try {
      setTestResult(await api.testPage(doc.id, testPage));
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
      void refresh();
    }
  }

  async function convert() {
    if (!doc) return;
    setStats(null);
    setWarnings([]);
    setError(null);
    setJob({ stage: "Starting", done: 0, total: 0 });
    setJobStartedAt(Date.now());
    try {
      for await (const event of api.convert(doc.id, { pages: [...selected], ...meta })) {
        if (event.type === "stage") setJob((current) => ({ done: 0, total: 0, ...current, stage: event.stage }));
        else if (event.type === "progress")
          setJob({ stage: event.stage, done: event.done, total: event.total });
        else if (event.type === "error") fail(event.message);
        else if (event.type === "done") {
          setStats(event.stats ?? null);
          setWarnings(event.warnings ?? []);
        }
      }
    } catch (e) {
      fail(e);
    } finally {
      setJob(null);
      setJobStartedAt(null);
      void refresh();
    }
  }

  const projection = doc ? estimate(doc.pages, selected, testResult?.elapsedMs) : null;
  const needsModel = projection !== null && projection.scanned > 0;
  const installed = model?.installed === true;

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">
          OCR Compose<span className="accent">.</span>
        </span>
        <span className="tagline">PDF → a real, reflowable EPUB</span>
      </header>

      <main>
        <ModelCard
          model={model}
          hardware={hardware}
          installing={installStartedAt !== null}
          log={installLog}
          elapsedMs={installElapsed}
          onInstall={install}
          onUnload={() => void modelAction("unload")}
          onRemove={() => void modelAction("remove")}
        />

        {doc ? (
          <FileCard doc={doc} selected={selected} onSelected={setSelected} onReset={forgetDocument} />
        ) : (
          <Dropzone onFile={(file) => void addFile(file)} busy={reading} />
        )}

        {doc && projection && needsModel && (
          <TestCard
            doc={doc}
            page={testPage}
            onPage={setTestPage}
            result={testResult}
            running={testing}
            ready={installed}
            onRun={() => void runTest()}
            projectedMs={testResult ? projection.totalMs : null}
          />
        )}

        {doc && projection && (
          <ConvertCard
            doc={doc}
            meta={meta}
            onMeta={setMeta}
            estimate={projection}
            ready={selected.size > 0 && (!needsModel || installed)}
            blocked={
              needsModel && !installed
                ? "Some selected pages are scans, so they need the model. Install it above, or select only native-text pages."
                : projection.totalMs === null
                  ? "Read one page above to learn this machine's speed and get a real time estimate."
                  : null
            }
            job={job ? { ...job, elapsedMs: jobElapsed } : null}
            stats={stats}
            warnings={warnings}
            onConvert={() => void convert()}
          />
        )}
      </main>

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
