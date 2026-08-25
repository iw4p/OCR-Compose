import { createContext, useContext } from "react";

export type DocumentContextValue = { documentId: string; conversionId?: string };

const DocumentContext = createContext<DocumentContextValue | null>(null);

export const DocumentProvider = DocumentContext.Provider;

export function useDocumentContext(): DocumentContextValue {
  const value = useContext(DocumentContext);
  if (!value) throw new Error("useDocumentContext used outside a DocumentProvider");
  return value;
}
