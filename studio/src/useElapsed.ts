import { useEffect, useState } from "react";

/** A clock that only runs while something long is happening. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now()); // else the first tick reads a clock left over from the last job
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}
