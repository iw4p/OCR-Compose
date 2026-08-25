import type { Book, ValidationIssue } from "../../src/contract";
import type { ModelInfo } from "../../src/models/registry";
import type { OcrBlock } from "../../src/pdf/ocr";
import type { TextLayerVerdict } from "../../src/pdf/textlayer";

export type { Book, Block, Footnote, ValidationIssue } from "../../src/contract";
export type { ModelInfo, ModelCapability, ModelSource } from "../../src/models/registry";
export type { OcrBlock } from "../../src/pdf/ocr";
export type { TextLayerVerdict } from "../../src/pdf/textlayer";

export type PageReport = {
  page: number;
  verdict: TextLayerVerdict;
  chars: number;
  imageCoverage: number;
  garble: number;
};

export type DocumentInfo = {
  id: string;
  name: string;
  kind: "pdf" | "epub";
  pageCount: number;
  pages: PageReport[];
  counts?: Record<TextLayerVerdict, number>;
  suggestedPage: number | null;
  title?: string;
  author?: string;
};

export type CompareResult = {
  modelId: string;
  ok: boolean;
  elapsedMs: number;
  blocks?: OcrBlock[];
  contractBlocks?: unknown[];
  error?: string;
};

class ApiError extends Error {
  issues?: ValidationIssue[];
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const problem = type.includes("json") ? await response.json() : { error: await response.text() };
    const error = new ApiError(problem.error || `Request failed (${response.status})`);
    error.issues = problem.issues;
    throw error;
  }
  return (type.includes("json") ? response.json() : response.blob()) as Promise<T>;
}

const postJson = <T>(path: string, value: unknown): Promise<T> =>
  api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

export const listModels = () => api<{ models: ModelInfo[] }>("/api/models");

export type ModelAction = "install" | "unload" | "remove";

export const runModelAction = (id: string, action: ModelAction) =>
  api<{ message: string; models: ModelInfo[] }>(`/api/models/${encodeURIComponent(id)}/${action}`, { method: "POST" });

export async function uploadDocument(file: File): Promise<
  | { document: DocumentInfo; book?: undefined; warnings?: undefined }
  | { document: DocumentInfo; book: Book; warnings: string[] }
> {
  return api("/api/documents", {
    method: "POST",
    headers: { "x-bookforge-filename": encodeURIComponent(file.name) },
    body: file,
  });
}

export const pageImageUrl = (documentId: string, page: number, scale = 1) =>
  `/api/documents/${documentId}/pages/${page}.png?scale=${scale}`;

export const assetUrl = (documentId: string, path: string, conversionId?: string) =>
  `/api/documents/${documentId}/assets/${path.split("/").map(encodeURIComponent).join("/")}` +
  (conversionId ? `?conversionId=${encodeURIComponent(conversionId)}` : "");

export const compareModels = (documentId: string, page: number, modelIds: string[]) =>
  postJson<{ page: number; results: CompareResult[] }>(`/api/documents/${documentId}/compare`, { page, modelIds });

export const convertDocument = (
  documentId: string,
  request: { pages: number[]; modelId?: string; title?: string; author?: string; language?: string },
) =>
  postJson<{
    conversionId: string;
    book: Book;
    warnings: string[];
    report: { counts: Record<TextLayerVerdict, number>; pages: PageReport[] };
  }>(`/api/documents/${documentId}/convert`, request);

export const validateBook = (book: unknown) => postJson<{ issues: ValidationIssue[] }>("/api/validate", { book });

export async function exportEpub(documentId: string, book: unknown, conversionId?: string): Promise<Blob> {
  return api<Blob>("/api/export/epub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, conversionId, book }),
  });
}
