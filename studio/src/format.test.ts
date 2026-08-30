import { describe, expect, test } from "vitest";
import { formatBytes, formatClock, formatDuration } from "./format";

describe("formatBytes", () => {
  test("scales to the unit a human would use", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_200_000_000)).toBe("1.1 GB");
    expect(formatBytes(3_200_000_000)).toBe("3.0 GB");
  });
});

describe("formatDuration", () => {
  test("keeps only the precision the number deserves", () => {
    expect(formatDuration(400)).toBe("under a second");
    expect(formatDuration(4_200)).toBe("4.2 sec");
    expect(formatDuration(42_000)).toBe("42 sec");
    expect(formatDuration(90_000)).toBe("2 min");
    expect(formatDuration(35 * 60_000)).toBe("35 min");
    expect(formatDuration(2 * 3_600_000)).toBe("2 h");
    expect(formatDuration(2 * 3_600_000 + 55 * 60_000)).toBe("2 h 55 min");
  });

  test("never reports a minute as sixty seconds, or an hour as sixty minutes", () => {
    expect(formatDuration(59_600)).toBe("1 min");
    expect(formatDuration(3_599_000)).toBe("1 h");
    expect(formatDuration(3_600_000 + 59 * 60_000 + 59_000)).toBe("2 h");
  });
});

describe("formatClock", () => {
  test("counts like a stopwatch", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_000)).toBe("0:07");
    expect(formatClock(271_000)).toBe("4:31");
    expect(formatClock(4_360_000)).toBe("1:12:40");
  });
});
