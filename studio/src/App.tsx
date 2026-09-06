import { useCallback, useState } from "react";
import * as api from "./api";
import type { Book, ConvertStats, Doc, LivePage, TestResult } from "./api";
import { estimate } from "./estimate";
import { pagesWithContent } from "./pages";
import { useElapsed } from "./useElapsed";
import { useModel } from "./useModel";
import { ModelCard } from "./components/ModelCard";
import { Dropzone } from "./components/Dropzone";
import { FileCard } from "./components/FileCard";
import { TestCard } from "./components/TestCard";
import { BookCard } from "./components/BookCard";
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
  const [ocrAll, setOcrAll] = useState(false);

  const [testPage, setTestPage] = useState(1);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [job, setJob] = useState<Omit<Job, "elapsedMs"> | null>(null);
  const [livePage, setLivePage] = useState<LivePage | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const jobElapsed = useElapsed(jobStartedAt);
  const [stats, setStats] = useState<ConvertStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [book, setBook] = useState<Book | null>(null);
  const [saving, setSaving] = useState(false);

  /** Nothing measured about one document may survive into the next. */
  function forgetDocument() {
    setDoc(null);
    setSelected(new Set());
    setOcrAll(false);
    setTestResult(null);
    setStats(null);
    setWarnings([]);
    setBook(null);
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
    setBook(null);
    setError(null);
    setJob({ stage: "Starting", done: 0, total: 0 });
    setJobStartedAt(Date.now());
    let finished = false;
    try {
      for await (const event of api.convert(doc.id, { pages: [...selected], ...meta, ocrAll })) {
        if (event.type === "stage") setJob((current) => ({ done: 0, total: 0, ...current, stage: event.stage }));
        else if (event.type === "progress") setJob({ stage: event.stage, done: event.done, total: event.total });
        else if (event.type === "page") setLivePage({ page: event.page, regions: event.regions, blocks: event.blocks });
        else if (event.type === "error") fail(event.message);
        else if (event.type === "done") {
          setStats(event.stats ?? null);
          setWarnings(event.warnings ?? []);
          finished = true;
        }
      }
      if (finished) setBook(await api.getBook(doc.id));
    } catch (e) {
      fail(e);
    } finally {
      setJob(null);
      setJobStartedAt(null);
      setLivePage(null);
      void model.refresh();
    }
  }

  /** An edit from the Review card: optimistic, validated by the server, reverted on rejection. */
  async function changeBook(next: Book) {
    if (!doc) return;
    const previous = book;
    setBook(next);
    setSaving(true);
    try {
      const { stats: updated } = await api.putBook(doc.id, next);
      setStats((current) => (current ? { ...current, ...updated } : current));
    } catch (e) {
      setBook(previous);
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  const projection = doc ? estimate(doc.pages, selected, testResult?.elapsedMs, ocrAll) : null;
  const needsModel = projection !== null && projection.recognized > 0;

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
          onEnableFast={() => void model.enableFast()}
          onDisableFast={model.disableFast}
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
            ocrAll={ocrAll}
            onOcrAll={setOcrAll}
            estimate={projection}
            ready={selected.size > 0 && (!needsModel || model.installed)}
            blocked={
              needsModel && !model.installed
                ? ocrAll && projection.scanned === 0
                  ? "Paper mode sends every page through the model. Install it above, or turn paper mode off."
                  : "Some selected pages are scans, so they need the model. Install it above, or select only native-text pages."
                : projection.totalMs === null
                  ? "Read one page above to learn this machine's speed and get a real time estimate."
                  : null
            }
            job={job ? { ...job, elapsedMs: jobElapsed } : null}
            livePage={livePage}
            stats={stats}
            warnings={warnings}
            onConvert={() => void convert()}
          />
        )}

        {doc && book && !job && <BookCard docId={doc.id} book={book} busy={saving} onBook={(next) => void changeBook(next)} />}
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
