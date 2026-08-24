// Phase 0 spike: can mupdf (WASM) surface the four things `extract` needs?
//   1. text runs with font name + size
//   2. embedded image bytes
//   3. link annotations with targets
//   4. the bookmark tree
// Exit non-zero if any of the four is missing.
import * as mupdf from "mupdf";
import { readFileSync } from "node:fs";

const doc = mupdf.PDFDocument.openDocument(
  readFileSync(new URL("./test.pdf", import.meta.url)),
  "application/pdf"
);
console.log(`pages: ${doc.countPages()}\n`);
const results = {};

// 1. text runs with font name and size
console.log("== 1. text runs (font name + size) ==");
const runs = [];
for (let i = 0; i < doc.countPages(); i++) {
  const stext = JSON.parse(doc.loadPage(i).toStructuredText("preserve-spans").asJSON());
  for (const block of stext.blocks ?? [])
    for (const line of block.lines ?? [])
      runs.push({ page: i + 1, font: line.font?.name, size: line.font?.size, text: line.text });
}
for (const r of runs) console.log(`  p${r.page} [${r.font} @ ${r.size}pt] ${JSON.stringify(r.text)}`);
results.textRuns = runs.length > 0 && runs.every((r) => r.font && r.size > 0);

// 2. embedded image bytes
console.log("\n== 2. embedded image bytes ==");
const images = [];
for (let i = 0; i < doc.countPages(); i++) {
  doc.loadPage(i).toStructuredText("preserve-images").walk({
    onImageBlock(bbox, transform, image) {
      const png = image.toPixmap().asPNG();
      images.push({ page: i + 1, w: image.getWidth(), h: image.getHeight(), pngBytes: png.length });
    },
  });
}
for (const im of images) console.log(`  p${im.page} image ${im.w}x${im.h}, PNG ${im.pngBytes} bytes`);
results.imageBytes = images.length === 1 && images[0].w === 4 && images[0].pngBytes > 0;

// 3. link annotations with targets
console.log("\n== 3. link annotations ==");
const links = [];
for (let i = 0; i < doc.countPages(); i++)
  for (const link of doc.loadPage(i).getLinks()) {
    const uri = link.getURI();
    links.push({
      page: i + 1,
      external: link.isExternal(),
      target: link.isExternal() ? uri : JSON.stringify(doc.resolveLinkDestination(uri)),
    });
  }
for (const l of links) console.log(`  p${l.page} ${l.external ? "external" : "internal"} -> ${l.target}`);
results.links =
  links.some((l) => l.external && l.target.includes("example.org")) &&
  links.some((l) => !l.external && l.target.includes('"page":1'));

// 4. bookmark tree
console.log("\n== 4. bookmark tree ==");
const outline = doc.loadOutline();
const printOutline = (items, depth) => {
  let n = 0;
  for (const it of items ?? []) {
    const dest = doc.resolveLinkDestination(it.uri ?? "");
    console.log(`  ${"  ".repeat(depth)}${JSON.stringify(it.title)} -> page ${dest.page + 1}`);
    n += 1 + printOutline(it.down, depth + 1);
  }
  return n;
};
const outlineCount = printOutline(outline, 0);
results.bookmarks = outlineCount === 2;

// page labels, listed in DESIGN.md §5 for `extract` but not a Phase 0 gate
console.log("\n== extra: page labels API ==");
console.log(`  doc.getPageLabels: ${typeof doc.getPageLabels}`);

console.log("\n== verdict ==");
for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "PASS" : "FAIL"} ${k}`);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
