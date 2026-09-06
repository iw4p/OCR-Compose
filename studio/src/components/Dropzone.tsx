import { useRef, useState } from "react";

export function Dropzone({ onFile, busy }: { onFile: (file: File) => void; busy: boolean }) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      className={"dropzone" + (dragging ? " dragging" : "") + (busy ? " busy" : "")}
      onClick={() => !busy && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file && !busy) onFile(file);
      }}
    >
      <input
        ref={input}
        type="file"
        accept=".pdf,.epub,.json,application/pdf,application/epub+zip,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <strong>{busy ? "Reading the file…" : "Drop a PDF here"}</strong>
      <span className="sub">
        {busy
          ? "counting pages and checking each one for real text"
          : "or an EPUB or book.json to review and edit · click to choose · up to 512 MB"}
      </span>
    </div>
  );
}
