#!/usr/bin/env node
// CLI: every operation is exposed as a function (JSON in/out per DESIGN.md §7
// so non-TS ecosystems can shell out) with a thin argv wrapper below.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateBook, walkBlocks, type Book, type ValidationIssue } from "./contract.js";
import { readEpub } from "./epub/read.js";
import { writeEpub } from "./epub/write.js";

async function writeBookDir(bookDir: string, book: Book, assets: Map<string, Uint8Array>): Promise<void> {
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  for (const [name, bytes] of assets) {
    const path = join(bookDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

/** EPUB file → book folder (book.json + assets/). Returns reader warnings. */
export async function unpackEpub(epubPath: string, bookDir: string): Promise<string[]> {
  const { book, assets, warnings } = await readEpub(new Uint8Array(await readFile(epubPath)));
  await writeBookDir(bookDir, book, assets);
  return warnings;
}

/** PDF file → book folder, via the front end. Returns warnings + verdicts. */
export async function pdfToBookDir(
  pdfPath: string,
  bookDir: string,
  opts: { title?: string; author?: string; language?: string; pages?: number[]; ocr?: boolean } = {}
): Promise<{ warnings: string[]; counts: Record<string, number> }> {
  const { pdfToBook } = await import("./pdf/pdf.js");
  // the default provider; the Studio is where another one is chosen
  const { onnxtrEngine } = await import("./pdf/ocr.js");
  const { book, assets, warnings, report } = await pdfToBook(new Uint8Array(await readFile(pdfPath)), {
    ...(opts.title !== undefined && { title: opts.title }),
    ...(opts.author !== undefined && { author: opts.author }),
    ...(opts.language !== undefined && { language: opts.language }),
    ...(opts.pages !== undefined && { pages: opts.pages }),
    ...(opts.ocr && {
      ocr: onnxtrEngine(),
      onProgress: (done: number, total: number) => {
        if (done % 10 === 0 || done === total) console.error(`ocr: ${done}/${total} pages`);
      },
    }),
  });
  await writeBookDir(bookDir, book, assets);
  return { warnings, counts: report.counts };
}

/** Parse `1,3,8-10` into sorted, unique 1-based PDF page numbers. */
export function parsePageSpec(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw new Error(`invalid page selection: ${JSON.stringify(spec)}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first)
      throw new Error(`invalid page selection: ${JSON.stringify(spec)}`);
    if (last - first > 10_000) throw new Error("page selection range is too large");
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function validateBookDir(bookDir: string): Promise<ValidationIssue[]> {
  const raw: unknown = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
  return validateBook(raw);
}

/** Book folder → EPUB file. Refuses to pack an invalid book. */
export async function packBookDir(bookDir: string, epubPath: string): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
  const issues = validateBook(raw);
  if (issues.length > 0)
    throw new Error(
      `book.json is not valid:\n` +
        issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    );
  const book = raw as Book;

  const assets = new Map<string, Uint8Array>();
  const collect = async (name: string | undefined) => {
    if (name && !assets.has(name))
      assets.set(name, new Uint8Array(await readFile(join(bookDir, name))));
  };
  await collect(book.cover);
  for (const { block } of walkBlocks(book)) {
    if ("file" in block) await collect(block.file);
    if ("image" in block) await collect(block.image);
  }
  await writeFile(epubPath, await writeEpub(book, assets));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "unpack": {
        const [epub, dir] = args;
        if (!epub || !dir) throw new Error("usage: bookforge unpack <in.epub> <book-dir>");
        const warnings = await unpackEpub(epub, dir);
        for (const w of warnings) console.error(`warning: ${w}`);
        console.log(`unpacked to ${dir}/book.json${warnings.length ? ` (${warnings.length} warnings)` : ""}`);
        return 0;
      }
      case "pack": {
        const [dir, epub] = args;
        if (!dir || !epub) throw new Error("usage: bookforge pack <book-dir> <out.epub>");
        await packBookDir(dir, epub);
        console.log(`packed ${epub}`);
        return 0;
      }
      case "pdf": {
        const positional = args.filter((a) => !a.startsWith("--"));
        const flag = (name: string) => {
          const i = args.indexOf(`--${name}`);
          return i !== -1 ? args[i + 1] : undefined;
        };
        const [pdf, dir] = positional;
        if (!pdf || !dir)
          throw new Error("usage: bookforge pdf <in.pdf> <book-dir> [--title T] [--author A] [--lang L] [--pages 1,3-5] [--ocr]");
        const opts = {
          ...(flag("title") !== undefined && { title: flag("title")! }),
          ...(flag("author") !== undefined && { author: flag("author")! }),
          ...(flag("lang") !== undefined && { language: flag("lang")! }),
          ...(flag("pages") !== undefined && { pages: parsePageSpec(flag("pages")!) }),
          ...(args.includes("--ocr") && { ocr: true }),
        };
        const { warnings, counts } = await pdfToBookDir(pdf, dir, opts);
        console.log(`textlayer: ${JSON.stringify(counts)}`);
        for (const w of warnings) console.error(`warning: ${w}`);
        console.log(`converted to ${dir}/book.json${warnings.length ? ` (${warnings.length} warnings)` : ""}`);
        return 0;
      }
      case "validate": {
        const [dir] = args;
        if (!dir) throw new Error("usage: bookforge validate <book-dir>");
        const issues = await validateBookDir(dir);
        if (issues.length === 0) {
          console.log("valid");
          return 0;
        }
        for (const issue of issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
        return 1;
      }
      case "studio": {
        const portFlag = args.indexOf("--port");
        const port = portFlag === -1 ? 4173 : Number(args[portFlag + 1]);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("usage: bookforge studio [--port 4173]");
        const { startStudio } = await import("./studio/server.js");
        const studio = await startStudio({ port });
        console.log(`Bookforge Studio: ${studio.url}`);
        await new Promise<void>((resolve) => {
          const stop = () => studio.server.close(() => resolve());
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }
      default:
        console.error("usage: bookforge <pdf|unpack|pack|validate|studio> …");
        return 2;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
