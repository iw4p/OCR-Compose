// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Book } from "../api";
import { BookCard } from "./BookCard";

afterEach(cleanup);

const book = (): Book => ({
  title: "Paper",
  language: "en",
  content: [
    { type: "heading", level: 1, text: "Abstract" },
    { type: "text", text: "Retrieval with *pairwise* signals and math $\\tau$." },
    { type: "image", file: "assets/fig-1-abc.png", caption: "Figure 1", page: 1 },
    { type: "table", rows: [["Model", "Score"], ["Ours", "71.8"]] },
  ],
  footnotes: {},
});

const show = (props: Partial<Parameters<typeof BookCard>[0]> = {}) =>
  render(<BookCard docId="d1" book={book()} busy={false} onBook={() => {}} {...props} />);

describe("reading", () => {
  test("renders the blocks as a book, dialect included", () => {
    show();
    expect(screen.getByRole("heading", { name: "Abstract" })).toBeTruthy();
    expect(screen.getByText("pairwise").tagName).toBe("EM");
    expect(screen.getByText("\\tau").className).toContain("tex");
    expect(screen.getByRole("img").getAttribute("src")).toBe("/api/documents/d1/assets/fig-1-abc.png");
    expect(screen.getByText("71.8")).toBeTruthy();
  });
});

describe("editing", () => {
  test("saves an edited paragraph back into the content", () => {
    const onBook = vi.fn();
    show({ onBook });
    fireEvent.click(screen.getAllByTitle("edit")[1]!); // the paragraph
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Rewritten." } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(onBook).toHaveBeenCalledOnce();
    expect((onBook.mock.calls[0]![0] as Book).content[1]).toMatchObject({ type: "text", text: "Rewritten." });
  });

  test("cancel leaves the book untouched", () => {
    const onBook = vi.fn();
    show({ onBook });
    fireEvent.click(screen.getAllByTitle("edit")[0]!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onBook).not.toHaveBeenCalled();
  });

  test("moving a block swaps it with its neighbour", () => {
    const onBook = vi.fn();
    show({ onBook });
    fireEvent.click(screen.getAllByTitle("move down")[0]!);
    const next = onBook.mock.calls[0]![0] as Book;
    expect(next.content[0]).toMatchObject({ type: "text" });
    expect(next.content[1]).toMatchObject({ type: "heading" });
  });

  test("removing a block removes exactly that block", () => {
    const onBook = vi.fn();
    show({ onBook });
    fireEvent.click(screen.getAllByTitle("remove")[2]!); // the figure
    const next = onBook.mock.calls[0]![0] as Book;
    expect(next.content).toHaveLength(3);
    expect(next.content.some((b) => b.type === "image")).toBe(false);
  });

  test("a table offers move and remove but no text edit", () => {
    show();
    expect(screen.getAllByTitle("edit")).toHaveLength(3); // heading, paragraph, image caption
  });
});
