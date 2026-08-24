// The DESIGN.md §4 excerpt as a test fixture — the contract's own founding
// example must always validate.
import type { Book } from "./contract.js";

export const feldtheorie: Book = {
  title: "Feldtheorie",
  author: "K. Weiss",
  language: "de",
  cover: "assets/cover.jpg",
  content: [
    { type: "heading", level: 2, id: "sec-2-3", text: "2.3 Die Lagrange-Dichte", page: 41 },
    {
      type: "text",
      text: "Die Bewegungsgleichungen eines Feldes lassen sich aus einem Variationsprinzip herleiten. Wir betrachten die Wirkung $S$ als Funktional der Feldkonfiguration.",
      page: 41,
    },
    {
      type: "text",
      text: "Der Übergang zur Feldtheorie erfolgt, indem $q_i(t)$ durch das Feld $\\phi(x,t)$ ersetzt wird.[^ch2-fn7]",
      pages: [{ page: 41 }, { page: 42, at: 53 }],
    },
    {
      type: "formula",
      display: true,
      id: "eq-2-14",
      tex: "S[\\phi] = \\int d^4x \\, \\mathcal{L}(\\phi, \\partial_\\mu \\phi)",
      number: "2.14",
      page: 42,
    },
    {
      type: "formula",
      display: true,
      tex: null,
      image: "assets/eq-2-15.png",
      note: "margin annotation, not parsed",
      page: 42,
    },
    {
      type: "quote",
      text: "Le principe de moindre action est le plus beau théorème de la mécanique.",
      language: "fr",
      attribution: "Maupertuis",
      page: 43,
    },
    {
      type: "image",
      file: "assets/fig-2-4.png",
      caption: "Feldkonfiguration mit stationärer Wirkung.",
      page: 43,
    },
    {
      type: "text",
      text: "Für Felder mit *innerer Symmetrie* führt dies auf die Noether-Ströme, wie in [Gl. 2.14](#eq-2-14) angelegt.",
      page: 43,
    },
    {
      type: "table",
      image: "assets/tab-2-2.png",
      rows: null,
      caption: "Kopplungskonstanten.",
      scanned: true,
      page: 44,
    },
  ],
  footnotes: {
    "ch2-fn7": {
      label: "7",
      blocks: [{ type: "text", text: "Vgl. Landau & Lifschitz, *Klassische Feldtheorie*, §2." }],
    },
  },
};
