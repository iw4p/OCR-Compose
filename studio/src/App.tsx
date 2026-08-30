import { useCallback, useState } from "react";
import * as api from "./api";
import type { ConvertStats, Doc, TestResult } from "./api";
import { estimate } from "./estimate";
import { pagesWithContent } from "./pages";
import { useElapsed } from "./useElapsed";
import { useModel } from "./useModel";
import { ModelCard } from "./components/ModelCard";
import { Dropzone } from "./components/Dropzone";
import { FileCard } from "./components/FileCard";
import { TestCard } from "./components/TestCard";
import { ConvertCard, type Job, type Meta } from "./components/ConvertCard";

export default function App() {
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((problem: unknown) => {
    setError(problem instanceof Error ? problem.message : String(problem));
  }, []);

  const model = useModel(fail);

  const [doc, setDoc] = useState<Doc | null>(null);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [meta, setMeta] = useState<Meta>({ title: "", author: "", language: "en" });

  const [testPage, setTestPage] = useState(1);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [job, setJob] = useState<Omit<Job, "elapsedMs"> | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const jobElapsed = useElapsed(jobStartedAt);
  const [stats, setStats] = useState<ConvertStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

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
      setSelected(pagesWithContent(added.pages));
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
      void model.refresh();
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
        else if (event.type === "progress") setJob({ stage: event.stage, done: event.done, total: event.total });
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
      void model.refresh();
    }
  }

  const projection = doc ? estimate(doc.pages, selected, testResult?.elapsedMs) : null;
  const needsModel = projection !== null && projection.scanned > 0;

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
          model={model.status}
          hardware={model.hardware}
          installing={model.installing}
          log={model.log}
          elapsedMs={model.elapsedMs}
          onInstall={() => void model.install()}
          onUnload={model.unload}
          onRemove={model.remove}
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
            ready={model.installed}
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
            ready={selected.size > 0 && (!needsModel || model.installed)}
            blocked={
              needsModel && !model.installed
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
