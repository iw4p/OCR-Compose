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
        accept=".pdf,application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <strong>{busy ? "Reading the PDF…" : "Drop a PDF here"}</strong>
      <span className="sub">{busy ? "counting pages and checking each one for real text" : "or click to choose one · up to 512 MB"}</span>
    </div>
  );
}
