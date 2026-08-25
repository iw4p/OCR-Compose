export function Toast({ message, tone = "info" }: { message: string; tone?: "info" | "error" }) {
  return <div className={"toast toast-" + tone}>{message}</div>;
}

export function BusyOverlay({ title, copy }: { title: string; copy?: string }) {
  return (
    <div className="busy-overlay">
      <div className="busy-card">
        <div className="spinner" />
        <strong>{title}</strong>
        {copy && <span>{copy}</span>}
      </div>
    </div>
  );
}
