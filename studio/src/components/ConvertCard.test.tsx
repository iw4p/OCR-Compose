// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvertStats, Doc } from "../api";
import type { Estimate } from "../estimate";
import { ConvertCard } from "./ConvertCard";

afterEach(cleanup);

const doc = { id: "d1", name: "alice.pdf" } as Doc;
const projection = (over: Partial<Estimate> = {}): Estimate => ({
  selected: 10,
  scanned: 10,
  native: 0,
  blank: 0,
  totalMs: 600_000,
  ...over,
});

const show = (props: Partial<Parameters<typeof ConvertCard>[0]> = {}) =>
  render(
    <ConvertCard
      doc={doc}
      meta={{ title: "Alice", author: "Carroll", language: "en" }}
      onMeta={() => {}}
      estimate={projection()}
      ready
      blocked={null}
      job={null}
      stats={null}
      warnings={[]}
      onConvert={() => {}}
      {...props}
    />,
  );

describe("before it runs", () => {
  test("shows the projected duration and what it covers", () => {
    show();
    expect(screen.getByText("10 min")).toBeTruthy();
    expect(screen.getByText(/10 scanned, 0 native, 0 blank/)).toBeTruthy();
  });

  test("offers no estimate at all when no page has been timed", () => {
    show({ estimate: projection({ totalMs: null }) });
    expect(screen.queryByText(/^\d+ min$/)).toBeNull();
  });

  test("says why it cannot start, and refuses to", () => {
    const onConvert = vi.fn();
    show({ ready: false, blocked: "Install the model above.", onConvert });
    expect(screen.getByText("Install the model above.")).toBeTruthy();
    const button = screen.getByRole("button", { name: /convert 10 pages/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onConvert).not.toHaveBeenCalled();
  });
});

describe("while it runs", () => {
  test("reports the stage and the pages done so far", () => {
    show({ job: { stage: "Recognizing scanned pages", done: 3, total: 10, elapsedMs: 60_000 } });
    expect(screen.getByText("3/10")).toBeTruthy();
    expect(screen.getByText(/Recognizing scanned pages/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /convert/i })).toBeNull();
  });

  // The estimate is a projection; once pages start landing the machine's own
  // rate is better evidence, so the remaining time comes from that instead.
  test("recomputes the time left from the rate actually achieved", () => {
    show({
      estimate: projection({ totalMs: 600_000 }),
      job: { stage: "Recognizing scanned pages", done: 2, total: 10, elapsedMs: 120_000 },
    });
    expect(screen.getByText(/8 min left/)).toBeTruthy();
  });

  test("falls back to the projection before the first page lands", () => {
    show({ job: { stage: "Loading the model", done: 0, total: 0, elapsedMs: 60_000 } });
    expect(screen.getByText(/9 min left/)).toBeTruthy();
  });
});

describe("once it is done", () => {
  const stats: ConvertStats = {
    blocks: 680,
    footnotes: 4,
    epubBytes: 228_687,
    counts: { native: 10, scanned: 0, "no-text": 0 },
  };

  test("shows what came out and offers both downloads", () => {
    show({ stats });
    expect(screen.getByText("680")).toBeTruthy();
    expect(screen.getByText("223 KB")).toBeTruthy();
    expect(screen.getByRole("link", { name: /download epub/i }).getAttribute("href")).toBe("/api/documents/d1/epub");
    expect(screen.getByRole("link", { name: /book\.json/i }).getAttribute("href")).toBe("/api/documents/d1/book.json");
  });

  test("keeps warnings available without shouting them", () => {
    show({ stats, warnings: ["3 pages OCRed with PaddleOCR-VL"] });
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(screen.getByText("3 pages OCRed with PaddleOCR-VL")).toBeTruthy();
  });
});
