#!/usr/bin/env python3
"""Persistent JSONL bridge to OnnxTR, docTR's pure-ONNX fork (no PyTorch).

stdin:  {"id": 1, "path": "/absolute/page.png", "reco": "parseq"}
stdout: {"id": 1, "items": [...], "regions": [...]}

`items` are the page's text blocks and tables in reading order, carrying OnnxTR's
own layout class as `label`. `regions` are the layout regions that hold no
recognizable text — a picture is its pixels — which TypeScript crops out of the
page render. Boxes are [x0, y0, x1, y1] relative to the page with a top-left
origin: OnnxTR's native convention, so nothing is rescaled here.

Labels stay raw. Mapping them onto the vocabulary `ocrBlocksToBookBlocks` reads,
and serializing table cells, happen in TypeScript (`src/pdf/ocr.ts`) where they
are covered by fixture tests. `reco` picks the recognizer per request — an arch
name, or `hub:<repo id>` for the multilingual weights.
"""

from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from typing import Any

# Books are dense: detection accuracy matters more than 0.4s a page.
DET_ARCH = "db_resnet50"

# A layout class whose content is the pixels, not the characters. OnnxTR has no
# math recognizer, so a formula keeps its picture instead of inventing TeX.
REGION_LABELS = {"Picture", "Formula"}


def _numbers(value: Any) -> list[float]:
    if hasattr(value, "tolist"):
        return _numbers(value.tolist())
    if isinstance(value, (list, tuple)):
        out: list[float] = []
        for item in value:
            out.extend(_numbers(item))
        return out
    try:
        return [float(value)]
    except (TypeError, ValueError):
        return []


def _box(geometry: Any) -> list[float] | None:
    """((xmin,ymin),(xmax,ymax)) or a flattened polygon, already relative."""
    coordinates = _numbers(geometry)
    if len(coordinates) < 4:
        return None
    xs, ys = coordinates[0::2], coordinates[1::2]
    return [min(xs), min(ys), max(xs), max(ys)]


def _items(page: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from onnxtr.io.elements import Table
    from onnxtr.io.exporters import page_reading_order

    ordered, labels, _ = page_reading_order(page)
    items: list[dict[str, Any]] = []
    for item, label in zip(ordered, labels):
        box = _box(item.geometry)
        if box is None:
            continue
        if isinstance(item, Table):
            items.append(
                {
                    "label": "Table",
                    "box": box,
                    "rows": int(item.num_rows),
                    "cols": int(item.num_cols),
                    "cells": [
                        {
                            "row_start": int(cell.row_start),
                            "row_end": int(cell.row_end),
                            "col_start": int(cell.col_start),
                            "col_end": int(cell.col_end),
                            "value": str(cell.value),
                        }
                        for cell in item.cells
                    ],
                }
            )
        else:
            items.append({"label": str(label or "Text"), "text": item.render(), "box": box})

    regions: list[dict[str, Any]] = []
    for region in page.layout:
        box = _box(region.geometry) if region.type in REGION_LABELS else None
        if box is not None:
            regions.append({"label": str(region.type), "text": "", "box": box})
    return items, regions


def main() -> int:
    try:
        with redirect_stdout(sys.stderr):
            from onnxtr.io import DocumentFile
            from onnxtr.models import EngineConfig, from_hub, ocr_predictor
    except Exception as error:
        print(
            "Cannot import OnnxTR. Install Python >=3.11 and `onnxtr[cpu]`. "
            f"Original error: {error}",
            file=sys.stderr,
        )
        return 2

    # The CPU provider everywhere: onnxruntime dispatches SIMD at runtime, so it
    # is fast on any x86-64 or arm64 machine, and it is the only provider that
    # runs every one of these graphs (CoreML miscompiles `parseq`).
    cpu = EngineConfig(providers=["CPUExecutionProvider"])

    # One predictor at a time: switching recognizer replaces it rather than
    # holding two sets of weights in memory.
    current: dict[str, Any] = {}

    def predictor(reco: str) -> Any:
        if current.get("reco") != reco:
            current.clear()
            current["reco"] = reco
            current["model"] = ocr_predictor(
                det_arch=DET_ARCH,
                reco_arch=from_hub(reco[4:], engine_cfg=cpu) if reco.startswith("hub:") else reco,
                detect_layout=True,
                detect_tables=True,
                keep_reading_order=True,
                resolve_blocks=True,
                det_engine_cfg=cpu,
                reco_engine_cfg=cpu,
                clf_engine_cfg=cpu,
                layout_engine_cfg=cpu,
                table_engine_cfg=cpu,
            )
        return current["model"]

    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            with redirect_stdout(sys.stderr):
                page = predictor(request.get("reco") or "parseq")(
                    DocumentFile.from_images(request["path"])
                ).pages[0]
                items, regions = _items(page)
            reply = {"id": request["id"], "items": items, "regions": regions}
        except Exception as error:
            reply = {"id": request.get("id", -1), "error": str(error)}
        print(json.dumps(reply, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
