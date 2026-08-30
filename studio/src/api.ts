import type { Block } from "../../src/contract";
import type { ModelStatus } from "../../src/models/registry";
import type { OcrBlock } from "../../src/pdf/ocr";
import type { TextLayerVerdict } from "../../src/pdf/textlayer";

export type { Block } from "../../src/contract";
export type { ModelStatus } from "../../src/models/registry";
export type { OcrBlock } from "../../src/pdf/ocr";
export type { TextLayerVerdict } from "../../src/pdf/textlayer";

export type PageReport = { page: number; verdict: TextLayerVerdict; chars: number; imageCoverage: number; garble: number };

export type Hardware = { cpu: string; cores: number; memoryBytes: number; platform: string };

export type Doc = {
  id: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
  pages: PageReport[];
  counts: Record<TextLayerVerdict, number>;
  suggestedPage: number;
  title: string;
  author: string;
};

export type TestResult = { page: number; elapsedMs: number; regions: OcrBlock[]; blocks: Block[] };

export type ConvertStats = {
  blocks: number;
  footnotes: number;
  epubBytes: number;
  counts: Record<TextLayerVerdict, number>;
};

export type JobEvent =
  | { type: "log"; line: string }
  | { type: "stage"; stage: string }
  | { type: "progress"; stage: string; done: number; total: number }
  | { type: "done"; message?: string; stats?: ConvertStats; warnings?: string[] }
  | { type: "error"; message: string };

const errorFrom = async (response: Response): Promise<string> => {
  const fallback = `Request failed (${response.status})`;
  const problem = await response.json().catch(() => null);
  return problem?.error ?? fallback;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorFrom(response));
  return response.json() as Promise<T>;
}

/** Consumes a server job stream, one JSON event at a time, as it happens. */
async function* jobEvents(path: string, body?: unknown): AsyncGenerator<JobEvent> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  // A job that failed before it could stream answers with a status, not events:
  // without this the loop below would just end and the failure would vanish.
  if (!response.ok) throw new Error(await errorFrom(response));
  if (!response.body) throw new Error("the server closed the connection");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part.startsWith("data: ")) yield JSON.parse(part.slice(6)) as JobEvent;
  }
}

export const getStatus = () => request<{ model: ModelStatus; hardware: Hardware }>("/api/status");

export const installModel = () => jobEvents("/api/model/install");

export const modelAction = (action: "unload" | "remove") =>
  request<{ message: string; model: ModelStatus }>(`/api/model/${action}`, { method: "POST" });

export const addDocument = (file: File) =>
  request<Doc>("/api/documents", {
    method: "POST",
    headers: { "x-ocr-compose-filename": encodeURIComponent(file.name) },
    body: file,
  });

export const pageImage = (id: string, page: number, scale = 1) => `/api/documents/${id}/pages/${page}.png?scale=${scale}`;

export const testPage = (id: string, page: number) =>
  request<TestResult>(`/api/documents/${id}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page }),
  });

export const convert = (
  id: string,
  options: { pages: number[]; title: string; author: string; language: string },
) => jobEvents(`/api/documents/${id}/convert`, options);

export const downloadUrl = (id: string, what: "epub" | "book.json") => `/api/documents/${id}/${what}`;
