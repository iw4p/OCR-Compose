import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { disableFastMode, enableFastMode, fastModeStatus } from "./fastmode.js";

// Platform support is the caller's gate (registry.ts); the marker and install
// logic here are pure file work, so they are tested on any platform against a
// temporary root and a fake interpreter directory.

const roots: string[] = [];
const tempRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-compose-fastmode-"));
  roots.push(root);
  return root;
};

/** A fake venv: a `python` path, with or without `mlx_vlm.server` beside it. */
const fakePython = async (root: string, withMlx: boolean) => {
  const bin = join(root, "venv", "bin");
  await mkdir(bin, { recursive: true });
  const python = join(bin, "python");
  await writeFile(python, "#!/bin/sh\n");
  if (withMlx) await writeFile(join(bin, "mlx_vlm.server"), "#!/bin/sh\n");
  return python;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("fast mode marker", () => {
  test("enable writes the marker and reports what changed; disable removes it", async () => {
    const root = await tempRoot();
    const python = await fakePython(root, true);
    expect((await fastModeStatus(python, root)).enabled).toBe(false);

    const on = await enableFastMode(python, { allowInstall: false, root });
    expect(on).toContain("Fast mode on");
    expect(await fastModeStatus(python, root)).toMatchObject({ installed: true, enabled: true });

    expect(await disableFastMode(root)).toContain("Fast mode off");
    expect((await fastModeStatus(python, root)).enabled).toBe(false);
  });

  test("disabling what was never enabled says so instead of pretending", async () => {
    const root = await tempRoot();
    expect(await disableFastMode(root)).toBe("Fast mode is not enabled.");
  });

  test("status without any python reports not installed", async () => {
    const root = await tempRoot();
    expect(await fastModeStatus(null, root)).toMatchObject({ installed: false, enabled: false, running: false });
  });
});

describe("installing mlx-vlm", () => {
  test("never installs into an environment we did not create", async () => {
    const root = await tempRoot();
    const python = await fakePython(root, false);
    await expect(enableFastMode(python, { allowInstall: false, root })).rejects.toThrow("will not install into it");
    expect((await fastModeStatus(python, root)).enabled).toBe(false);
  });

  test("installs into a managed environment, then enables", async () => {
    const root = await tempRoot();
    const python = await fakePython(root, false);
    const installed: string[] = [];
    const install = async (target: string) => {
      installed.push(target);
      await writeFile(join(root, "venv", "bin", "mlx_vlm.server"), "#!/bin/sh\n");
    };
    await enableFastMode(python, { allowInstall: true, root, install });
    expect(installed).toEqual([python]);
    expect(await fastModeStatus(python, root)).toMatchObject({ installed: true, enabled: true });
  });
});
