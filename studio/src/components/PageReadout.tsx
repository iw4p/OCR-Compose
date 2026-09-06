import type { Block, OcrBlock } from "../api";
import { pageImage } from "../api";
import { describeBlock } from "../blocks";

/**
 * One recognized page, as evidence: the render with the model's regions drawn
 * over it, beside the blocks they became. The Test card shows it for the
 * sample page; the Convert card streams one per page as the conversion runs.
 */
export function PageReadout({ docId, page, regions, blocks }: { docId: string; page: number; regions: OcrBlock[]; blocks: Block[] }) {
  return (
    <div className="test-split">
      <div className="page-shot">
        <img src={pageImage(docId, page, 1)} alt={`page ${page}`} />
        {regions.map((region, i) => (
          <span
            key={i}
            className="region"
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.w * 100}%`,
              height: `${region.h * 100}%`,
            }}
            title={region.label}
          />
        ))}
      </div>
      <ol className="blocks">
        {blocks.length === 0 && <li className="dim">Nothing recognized on this page.</li>}
        {blocks.map((block, i) => {
          const { kind, text } = describeBlock(block);
          return (
            <li key={i}>
              <span className="kind">{kind}</span>
              <span className="block-text">{text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
