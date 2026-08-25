import { assetUrl } from "../api";

export function AssetImage({
  documentId,
  conversionId,
  file,
  alt,
}: {
  documentId: string;
  conversionId?: string;
  file?: string;
  alt?: string;
}) {
  if (!file) return <div className="asset-missing">no file set</div>;
  return (
    <img
      className="asset-preview"
      src={assetUrl(documentId, file, conversionId)}
      alt={alt || file}
      loading="lazy"
      onError={(e) => e.currentTarget.classList.add("asset-error")}
    />
  );
}
