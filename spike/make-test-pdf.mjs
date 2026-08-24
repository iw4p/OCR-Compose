// Phase 0 spike: handcraft a small born-digital PDF containing exactly the
// four features the spike must extract (DESIGN.md §7.1):
//   1. text runs with distinct fonts (Helvetica + Times-Italic) and sizes
//   2. an embedded image (4x4 RGB, Flate-compressed)
//   3. link annotations (one external URI, one internal destination)
//   4. a two-level bookmark tree
// Base-14 fonts are used so no font embedding is needed; the *names* still
// appear on the text runs, which is what extraction must surface.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const objects = []; // 1-indexed bodies, without "N 0 obj"/"endobj"
const add = (body) => objects.push(body) /* returns count */;

// 4x4 RGB checkerboard, red/white
const raw = Buffer.alloc(4 * 4 * 3);
for (let y = 0; y < 4; y++)
  for (let x = 0; x < 4; x++) {
    const on = (x + y) % 2 === 0;
    raw.set(on ? [255, 0, 0] : [255, 255, 255], (y * 4 + x) * 3);
  }
const img = deflateSync(raw);

const page1Content = Buffer.from(
  [
    "BT /F1 24 Tf 72 720 Td (Feldtheorie) Tj ET",
    "BT /F2 12 Tf 72 690 Td (2.3 Die Lagrange-Dichte) Tj ET",
    "BT /F1 10 Tf 72 670 Td (Die Wirkung S als Funktional der Feldkonfiguration.) Tj ET",
    "q 64 0 0 64 72 560 cm /Im1 Do Q",
  ].join("\n")
);
const page2Content = Buffer.from("BT /F1 10 Tf 72 720 Td (Seite zwei: Noether-Stroeme.) Tj ET");

add("<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /PageMode /UseOutlines >>"); // 1
add("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"); // 2
add(
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 6 0 R /F2 7 0 R >> /XObject << /Im1 8 0 R >> >> " +
    "/Contents 5 0 R /Annots [10 0 R 11 0 R] >>"
); // 3
add(
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 6 0 R >> >> /Contents 12 0 R >>"
); // 4
add({ dict: `<< /Length ${page1Content.length} >>`, stream: page1Content }); // 5
add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 6
add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>"); // 7
add({
  dict:
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>`,
  stream: img,
}); // 8
add("<< /Type /Outlines /First 13 0 R /Last 13 0 R /Count 2 >>"); // 9
add(
  "<< /Type /Annot /Subtype /Link /Rect [72 660 400 680] /Border [0 0 0] " +
    "/A << /S /URI /URI (https://example.org/feldtheorie) >> >>"
); // 10
add(
  "<< /Type /Annot /Subtype /Link /Rect [72 550 136 630] /Border [0 0 0] " +
    "/Dest [4 0 R /XYZ 0 792 null] >>"
); // 11
add({ dict: `<< /Length ${page2Content.length} >>`, stream: page2Content }); // 12
add(
  "<< /Title (Kapitel 2) /Parent 9 0 R /First 14 0 R /Last 14 0 R /Count 1 " +
    "/Dest [3 0 R /XYZ 0 792 null] >>"
); // 13
add("<< /Title (2.3 Die Lagrange-Dichte) /Parent 13 0 R /Dest [4 0 R /XYZ 0 792 null] >>"); // 14

// assemble with a correct xref table
const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
let offset = chunks[0].length;
const offsets = [];
objects.forEach((o, i) => {
  const head = Buffer.from(`${i + 1} 0 obj\n`);
  const body =
    typeof o === "string"
      ? Buffer.from(o + "\n")
      : Buffer.concat([Buffer.from(o.dict + "\nstream\n"), o.stream, Buffer.from("\nendstream\n")]);
  const tail = Buffer.from("endobj\n");
  offsets.push(offset);
  chunks.push(head, body, tail);
  offset += head.length + body.length + tail.length;
});
const xrefStart = offset;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
chunks.push(Buffer.from(xref));

writeFileSync(new URL("./test.pdf", import.meta.url), Buffer.concat(chunks));
console.log("wrote spike/test.pdf,", offset + xref.length, "bytes,", objects.length, "objects");
