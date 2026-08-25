import { useState } from "react";
import type { Block, ValidationIssue } from "../api";
import { BLOCK_TYPES, BLOCK_LABELS, type BlockType, newBlock, keyOf, carryKey } from "../blocks";
import { insertAt, moveItem, removeAt, updateAt } from "../arrayOps";
import { BlockCard } from "./BlockCard";

const pathMatches = (issuePath: (string | number)[], ownPath: (string | number)[]) =>
  ownPath.every((segment, i) => issuePath[i] === segment);

export function AddBlockButton({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-block">
      <button type="button" className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        + add block
      </button>
      {open && (
        <div className="add-block-menu">
          {BLOCK_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                onAdd(type);
                setOpen(false);
              }}
            >
              {BLOCK_LABELS[type]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BlockList({
  blocks,
  onChange,
  path,
  issues,
  emptyLabel = "No blocks yet.",
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  path: (string | number)[];
  issues: ValidationIssue[];
  emptyLabel?: string;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const relevant = issues.filter((issue) => pathMatches(issue.path, path));

  return (
    <div className="block-list">
      {blocks.length === 0 && <p className="block-list-empty">{emptyLabel}</p>}
      {blocks.map((block, index) => (
        <div
          key={keyOf(block)}
          id={"b-" + [...path, index].join("-")}
          className={"block-row" + (dragOver === index ? " drag-over" : "")}
          draggable
          onDragStart={() => setDragFrom(index)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(index);
          }}
          onDragLeave={() => setDragOver((v) => (v === index ? null : v))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            if (dragFrom === null || dragFrom === index) return;
            onChange(moveItem(blocks, dragFrom, index));
            setDragFrom(null);
          }}
          onDragEnd={() => {
            setDragFrom(null);
            setDragOver(null);
          }}
        >
          <BlockCard
            block={block}
            path={[...path, index]}
            issues={relevant}
            onChange={(next) => onChange(updateAt(blocks, index, carryKey(block, next)))}
            onDelete={() => onChange(removeAt(blocks, index))}
            onMove={(delta) => {
              const to = index + delta;
              if (to < 0 || to >= blocks.length) return;
              onChange(moveItem(blocks, index, to));
            }}
            canMoveUp={index > 0}
            canMoveDown={index < blocks.length - 1}
          />
        </div>
      ))}
      <AddBlockButton onAdd={(type) => onChange(insertAt(blocks, blocks.length, newBlock(type)))} />
    </div>
  );
}
