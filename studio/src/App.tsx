import { useEffect, useState } from "react";
import * as api from "./api";
import type { Book, CompareResult, DocumentInfo, ModelInfo, ValidationIssue } from "./api";
import { Dropzone } from "./components/Dropzone";
import { SelectScreen } from "./components/SelectScreen";
import { EditorScreen } from "./components/EditorScreen";
import { Toast, BusyOverlay } from "./components/Toast";

type Step = "upload" | "select" | "edit";

export default function App() {
  const [step, setStep] = useState<Step>("upload");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [pendingModels, setPendingModels] = useState<Set<string>>(new Set());
  const [document, setDocumentInfo] = useState<DocumentInfo | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [conversionId, setConversionId] = useState<string | undefined>(undefined);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [samplePage, setSamplePage] = useState<number | null>(null);
  const [compareSelection, setCompareSelection] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<CompareResult[]>([]);
  const [comparing, setComparing] = useState(false);
  const [convertModelId, setConvertModelId] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [validated, setValidated] = useState(false);
  const [busy, setBusy] = useState<{ title: string; copy?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "info" | "error" } | null>(null);

  useEffect(() => {
    api
      .listModels()
      .then((r) => setModels(r.models))
      .catch((e) => notify(e, "error"));
  }, []);

  function notify(error: unknown, tone: "info" | "error" = "info") {
    const message = error instanceof Error ? error.message : String(error);
    setToast({ message, tone });
    window.clearTimeout((notify as any)._t);
    (notify as any)._t = window.setTimeout(() => setToast(null), 5000);
  }

  async function handleUpload(file: File) {
    setBusy({ title: "Reading document", copy: file.name });
    try {
      const result = await api.uploadDocument(file);
      setDocumentInfo(result.document);
      if (result.book) {
        setBook(result.book);
        setStep("edit");
        if (result.warnings?.length) notify(`Loaded with ${result.warnings.length} warning(s): ${result.warnings[0]}`);
      } else {
        setSelectedPages(new Set(result.document.pages.filter((p) => p.verdict !== "no-text").map((p) => p.page)));
        setSamplePage(result.document.suggestedPage);
        setComparison([]);
        setConvertModelId(null);
        setStep("select");
      }
    } catch (e) {
      notify(e, "error");
    } finally {
      setBusy(null);
    }
  }

  async function handleModelAction(id: string, action: api.ModelAction) {
    setPendingModels((s) => new Set(s).add(id));
    try {
      const result = await api.runModelAction(id, action);
      setModels(result.models);
      notify(result.message);
    } catch (e) {
      notify(e, "error");
    } finally {
      setPendingModels((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleCompare() {
    if (!document || samplePage === null) return;
    setComparing(true);
    try {
      const result = await api.compareModels(document.id, samplePage, [...compareSelection]);
      setComparison(result.results);
    } catch (e) {
      notify(e, "error");
    } finally {
      setComparing(false);
    }
  }

  async function handleConvert(meta: { title: string; author: string; language: string }) {
    if (!document) return;
    setConverting(true);
    setBusy({ title: "Converting", copy: `${selectedPages.size} page(s)` });
    try {
      const result = await api.convertDocument(document.id, {
        pages: [...selectedPages],
        modelId: convertModelId ?? undefined,
        ...meta,
      });
      setBook(result.book);
      setConversionId(result.conversionId);
      setIssues([]);
      setValidated(false);
      setStep("edit");
      if (result.warnings.length) notify(`Converted with ${result.warnings.length} warning(s): ${result.warnings[0]}`);
    } catch (e) {
      notify(e, "error");
    } finally {
      setConverting(false);
      setBusy(null);
    }
  }

  async function handleValidate() {
    if (!book) return;
    setValidating(true);
    try {
      const result = await api.validateBook(book);
      setIssues(result.issues);
      setValidated(true);
      notify(result.issues.length === 0 ? "Valid — no issues." : `${result.issues.length} issue(s) found.`, result.issues.length ? "error" : "info");
    } catch (e) {
      notify(e, "error");
    } finally {
      setValidating(false);
    }
  }

  async function handleExport() {
    if (!book || !document) return;
    setExporting(true);
    try {
      const blob = await api.exportEpub(document.id, book, conversionId);
      downloadBlob(blob, `${book.title || "book"}.epub`);
    } catch (e: any) {
      if (e?.issues) {
        setIssues(e.issues);
        setValidated(true);
      }
      notify(e, "error");
    } finally {
      setExporting(false);
    }
  }

  function handleDownloadJson() {
    if (!book) return;
    downloadBlob(new Blob([JSON.stringify(book, null, 2)], { type: "application/json" }), "book.json");
  }

  function reset() {
    setStep("upload");
    setDocumentInfo(null);
    setBook(null);
    setConversionId(undefined);
    setIssues([]);
    setValidated(false);
  }

  function handleBookChange(next: Book) {
    setBook(next);
    setValidated(false);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button type="button" className="brand" onClick={reset}>
          Bookforge Studio
        </button>
        <nav className="steps">
          <span className={step === "upload" ? "active" : ""}>1. Source</span>
          <span className={step === "select" ? "active" : document?.kind === "pdf" && book ? "" : "disabled"}>2. Select &amp; compare</span>
          <span className={step === "edit" ? "active" : book ? "" : "disabled"}>3. Edit &amp; export</span>
        </nav>
        {document && (
          <div className="header-doc">
            {document.name}
            {step !== "upload" && (
              <button type="button" className="btn-ghost btn-small" onClick={reset}>
                new document
              </button>
            )}
          </div>
        )}
      </header>

      <div className="app-body">
        {step === "upload" && <Dropzone onFile={handleUpload} busy={busy !== null} />}

        {step === "select" && document && (
          <SelectScreen
            document={document}
            models={models}
            pending={pendingModels}
            onModelAction={handleModelAction}
            selectedPages={selectedPages}
            onSelectedPagesChange={setSelectedPages}
            samplePage={samplePage}
            onSamplePageChange={setSamplePage}
            compareSelection={compareSelection}
            onToggleCompareModel={(id) =>
              setCompareSelection((s) => {
                const next = new Set(s);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              })
            }
            comparison={comparison}
            comparing={comparing}
            onRunCompare={handleCompare}
            convertModelId={convertModelId}
            onChooseConvertModel={setConvertModelId}
            onConvert={handleConvert}
            converting={converting}
          />
        )}

        {step === "edit" && book && document && (
          <EditorScreen
            book={book}
            onChange={handleBookChange}
            documentId={document.id}
            conversionId={conversionId}
            issues={issues}
            validated={validated}
            onValidate={handleValidate}
            onExportEpub={handleExport}
            onDownloadJson={handleDownloadJson}
            validating={validating}
            exporting={exporting}
          />
        )}
      </div>

      {busy && <BusyOverlay title={busy.title} copy={busy.copy} />}
      {toast && <Toast message={toast.message} tone={toast.tone} />}
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
