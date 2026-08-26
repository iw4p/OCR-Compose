import { useState } from "react";
import type { CompareResult, DocumentInfo, ModelAction, ModelInfo } from "../api";
import { PageRail } from "./PageRail";
import { ModelCatalog } from "./ModelCatalog";
import { ComparePanel } from "./ComparePanel";
import { Field, TextInput } from "./fields";

export function SelectScreen({
  document,
  models,
  pending,
  onModelAction,
  selectedPages,
  onSelectedPagesChange,
  samplePage,
  onSamplePageChange,
  compareSelection,
  onToggleCompareModel,
  comparison,
  comparing,
  onRunCompare,
  convertModelId,
  onChooseConvertModel,
  onConvert,
  converting,
}: {
  document: DocumentInfo;
  models: ModelInfo[];
  pending: Set<string>;
  onModelAction: (id: string, action: ModelAction) => void;
  selectedPages: Set<number>;
  onSelectedPagesChange: (pages: Set<number>) => void;
  samplePage: number | null;
  onSamplePageChange: (page: number) => void;
  compareSelection: Set<string>;
  onToggleCompareModel: (id: string) => void;
  comparison: CompareResult[];
  comparing: boolean;
  onRunCompare: () => void;
  convertModelId: string | null;
  onChooseConvertModel: (id: string) => void;
  onConvert: (meta: { title: string; author: string; language: string }) => void;
  converting: boolean;
}) {
  const needsOcr = document.pages.some((p) => selectedPages.has(p.page) && p.verdict === "scanned");
  const [title, setTitle] = useState(document.title ?? document.name.replace(/\.pdf$/i, ""));
  const [author, setAuthor] = useState(document.author ?? "");
  const [language, setLanguage] = useState("en");

  return (
    <div className="select-screen">
      <PageRail
        documentId={document.id}
        pages={document.pages}
        selected={selectedPages}
        onSelectedChange={onSelectedPagesChange}
        samplePage={samplePage}
        onSamplePageChange={onSamplePageChange}
      />
      <div className="select-side">
        <h3>Models</h3>
        <ModelCatalog
          models={models}
          selected={compareSelection}
          onToggle={onToggleCompareModel}
          onAction={onModelAction}
          pending={pending}
          convertModelId={convertModelId}
          onChooseConvertModel={onChooseConvertModel}
        />

        <h3>Compare</h3>
        <p className="muted small">Optional. Not sure which model? Tick a few above and try them on one page.</p>
        <ComparePanel
          documentId={document.id}
          samplePage={samplePage}
          results={comparison}
          comparing={comparing}
          onRun={onRunCompare}
          canRun={samplePage !== null && compareSelection.size > 0}
          convertModelId={convertModelId}
          onChooseConvertModel={onChooseConvertModel}
        />

        <h3>Convert</h3>
        <div className="convert-meta">
          <Field label="title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="author">
            <TextInput value={author} onChange={(e) => setAuthor(e.target.value)} />
          </Field>
          <Field label="language">
            <TextInput value={language} onChange={(e) => setLanguage(e.target.value)} />
          </Field>
        </div>
        {needsOcr && !convertModelId && (
          <p className="status-error small">Selected pages include scanned pages, but no OCR model is installed — install one above.</p>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={selectedPages.size === 0 || (needsOcr && !convertModelId) || converting}
          onClick={() => onConvert({ title, author, language })}
        >
          {converting ? "converting..." : `Convert ${selectedPages.size} page${selectedPages.size === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
