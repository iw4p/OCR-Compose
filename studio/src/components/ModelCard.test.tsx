// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Hardware, ModelStatus } from "../api";
import { ModelCard } from "./ModelCard";

afterEach(cleanup);

const model = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  id: "paddleocr-vl-1.6",
  name: "PaddleOCR-VL",
  version: "1.6",
  description: "Document layout, multilingual OCR, tables and formulas.",
  installed: true,
  source: "managed",
  diskBytes: 1_200_000_000,
  weightsDiskBytes: 2_000_000_000,
  runtimeDownloadBytes: 1_200_000_000,
  weightsDownloadBytes: 2_000_000_000,
  loaded: false,
  fast: { supported: false, installed: false, enabled: false, running: false, downloadBytes: 300_000_000 },
  ...over,
});
const fast = (over: Partial<ModelStatus["fast"]> = {}): ModelStatus["fast"] => ({
  supported: true,
  installed: true,
  enabled: false,
  running: false,
  downloadBytes: 300_000_000,
  ...over,
});

const hardware: Hardware = { cpu: "Apple M4", cores: 10, memoryBytes: 17_179_869_184, platform: "darwin/arm64" };

const show = (over: Partial<ModelStatus> | null, props: Partial<Parameters<typeof ModelCard>[0]> = {}) =>
  render(
    <ModelCard
      model={over === null ? null : model(over)}
      hardware={hardware}
      installing={false}
      log={[]}
      elapsedMs={0}
      onInstall={() => {}}
      onEnableFast={() => {}}
      onDisableFast={() => {}}
      onUnload={() => {}}
      onRemove={() => {}}
      {...props}
    />,
  );

describe("before it is installed", () => {
  test("states the download size rather than starting a surprise", () => {
    show({ installed: false, source: null, diskBytes: 0, weightsDiskBytes: 0 });
    expect(screen.getByText("≈ 3.0 GB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install PaddleOCR-VL" })).toBeTruthy();
  });

  test("names the machine the estimates will come from", () => {
    show({ installed: false, source: null });
    expect(screen.getByText(/Apple M4 · 10 cores/)).toBeTruthy();
  });
});

describe("once installed", () => {
  test("reports what is on disk and whether it is resident", () => {
    show({ loaded: true });
    expect(screen.getByText("loaded in memory")).toBeTruthy();
    expect(screen.getByText("1.1 GB")).toBeTruthy();
    expect(screen.getByText("1.9 GB cached")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install PaddleOCR-VL" })).toBeNull();
  });

  test("offers to free memory only while something is loaded", () => {
    show({ loaded: false });
    expect(screen.queryByRole("button", { name: /free memory/i })).toBeNull();
    cleanup();
    show({ loaded: true });
    expect(screen.getByRole("button", { name: /free memory/i })).toBeTruthy();
  });

  test("a runtime we did not install is never offered for deletion", () => {
    show({ source: "external" });
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
  });

  test("uninstalling takes a confirmation that names the size", () => {
    const onRemove = vi.fn();
    show({}, { onRemove });

    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    expect(onRemove).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: /delete 1\.1 GB from disk/i });
    fireEvent.click(confirm);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  test("backing out of the confirmation leaves the runtime alone", () => {
    const onRemove = vi.fn();
    show({}, { onRemove });
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep it/i }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
  });
});

describe("fast mode", () => {
  test("is never mentioned off Apple Silicon", () => {
    show({});
    expect(screen.queryByText(/fast mode/i)).toBeNull();
  });

  test("offers one click on Apple Silicon, download size only when needed", () => {
    const onEnableFast = vi.fn();
    show({ fast: fast({ installed: false }) }, { onEnableFast });
    const button = screen.getByRole("button", { name: /enable fast mode \(≈ \d+ MB\)/i });
    fireEvent.click(button);
    expect(onEnableFast).toHaveBeenCalledOnce();
    cleanup();
    show({ fast: fast({ installed: true }) });
    expect(screen.getByRole("button", { name: "Enable fast mode" })).toBeTruthy();
  });

  test("shows it is on, and offers the way back off", () => {
    const onDisableFast = vi.fn();
    show({ fast: fast({ enabled: true }) }, { onDisableFast });
    expect(screen.getByText("on — Apple GPU")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /turn off/i }));
    expect(onDisableFast).toHaveBeenCalledOnce();
  });
});

describe("while installing", () => {
  test("shows the installer's own output and hides the actions", () => {
    show({ installed: false, source: null }, { installing: true, log: ["Collecting paddlepaddle"], elapsedMs: 71_000 });
    expect(screen.getByText(/Collecting paddlepaddle/)).toBeTruthy();
    expect(screen.getByText("1:11")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install PaddleOCR-VL" })).toBeNull();
  });
});

test("renders a placeholder until the status arrives", () => {
  const { container } = show(null);
  expect(container.querySelector(".skeleton")).toBeTruthy();
});
