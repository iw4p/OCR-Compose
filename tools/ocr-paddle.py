#!/usr/bin/env python3
"""Persistent JSONL bridge to the full PaddleOCR-VL 1.6 document pipeline.

stdin:  {"id": 1, "path": "/absolute/page.png"}
stdout: {"id": 1, "blocks": [{text,label,x,y,w,h}, ...]}

Coordinates are normalized with a top-left origin. Paddle logs are redirected
to stderr so stdout remains a machine-readable protocol.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import json
import sys
from typing import Any


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


def _result_dict(result: Any) -> dict[str, Any]:
    value = result.json
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise TypeError("Paddle result.json was not an object")
    nested = value.get("res")
    return nested if isinstance(nested, dict) else value


def _blocks(result: Any) -> list[dict[str, Any]]:
    data = _result_dict(result)
    width = float(data.get("width") or 0)
    height = float(data.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError("Paddle result did not include a valid image width and height")

    normalized: list[dict[str, Any]] = []
    for block in data.get("parsing_res_list") or []:
        if not isinstance(block, dict):
            continue
        text = block.get("block_content")
        if not isinstance(text, str) or not text.strip():
            continue
        coordinates = _numbers(block.get("block_bbox"))
        if len(coordinates) < 4:
            continue
        # rect is [x1,y1,x2,y2]; quad/poly are flattened point pairs.
        xs = coordinates[0::2]
        ys = coordinates[1::2]
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
        normalized.append(
            {
                "text": text,
                "label": str(block.get("block_label") or "text"),
                "x": max(0.0, x1 / width),
                "y": max(0.0, y1 / height),
                "w": max(0.0, min(width, x2) - max(0.0, x1)) / width,
                "h": max(0.0, min(height, y2) - max(0.0, y1)) / height,
            }
        )
    return normalized


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", help="Paddle device string, e.g. cpu or gpu:0")
    parser.add_argument("--vl-backend", help="VLM service backend, e.g. mlx-vlm-server")
    parser.add_argument("--vl-server-url", help="VLM service base URL")
    parser.add_argument("--vl-model-name", help="Model id exposed by the VLM service")
    args = parser.parse_args()

    try:
        with redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCRVL

            options: dict[str, Any] = {"pipeline_version": "v1.6"}
            if args.device:
                options["device"] = args.device
            if args.vl_backend:
                options["vl_rec_backend"] = args.vl_backend
            if args.vl_server_url:
                options["vl_rec_server_url"] = args.vl_server_url
            if args.vl_model_name:
                options["vl_rec_api_model_name"] = args.vl_model_name
            pipeline = PaddleOCRVL(**options)
    except Exception as error:
        print(
            "Cannot initialize PaddleOCR-VL 1.6. Install Python 3.9–3.13, "
            "PaddlePaddle >=3.2.1, and paddleocr[doc-parser] >=3.6.0. "
            f"Original error: {error}",
            file=sys.stderr,
        )
        return 2

    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            with redirect_stdout(sys.stderr):
                result = next(iter(pipeline.predict(request["path"])))
            reply = {"id": request["id"], "blocks": _blocks(result)}
        except Exception as error:
            reply = {"id": request.get("id", -1), "error": str(error)}
        print(json.dumps(reply, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
