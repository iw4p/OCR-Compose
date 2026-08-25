import type { OcrBlock } from "../api";
import { pageImageUrl } from "../api";

export function PagePreview({ documentId, page, blocks }: { documentId: string; page: number; blocks?: OcrBlock[] }) {
  return (
    <div className="page-preview">
      <img src={pageImageUrl(documentId, page, 2)} alt={`page ${page}`} />
      {blocks?.map((b, i) => (
        <div
          key={i}
          className="ocr-box"
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
          title={`${b.label}: ${b.text.slice(0, 80)}`}
        />
      ))}
    </div>
  );
}
