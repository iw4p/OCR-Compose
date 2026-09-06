import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type { Hardware, ModelStatus } from "./api";
import { useElapsed } from "./useElapsed";

/**
 * The model's whole lifecycle: what it is, whether it is installed or loaded,
 * and the install itself — which streams pip's output for minutes and so needs
 * a log and a clock of its own.
 */
export function useModel(onError: (problem: unknown) => void) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const elapsedMs = useElapsed(installStartedAt);

  const refresh = useCallback(async () => {
    try {
      const current = await api.getStatus();
      setStatus(current.model);
      setHardware(current.hardware);
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs one streaming job (install, or fast-mode enable) through the shared log. */
  const runJob = useCallback(
    async (events: AsyncGenerator<api.JobEvent>) => {
      setLog([]);
      setInstallStartedAt(Date.now());
      try {
        for await (const event of events) {
          if (event.type === "log") setLog((lines) => [...lines, event.line]);
          else if (event.type === "error") onError(new Error(event.message));
          else if (event.type === "done") {
            const summary = event.message;
            if (summary) setLog((lines) => [...lines, summary]);
          }
        }
      } catch (problem) {
        onError(problem);
      } finally {
        setInstallStartedAt(null);
        void refresh();
      }
    },
    [onError, refresh],
  );

  const install = useCallback(() => runJob(api.installModel()), [runJob]);
  const enableFast = useCallback(() => runJob(api.enableFastMode()), [runJob]);

  const act = useCallback(
    async (action: "unload" | "remove" | "fast/disable") => {
      try {
        setStatus((await api.modelAction(action)).model);
      } catch (problem) {
        onError(problem);
      }
    },
    [onError],
  );

  return {
    status,
    hardware,
    installed: status?.installed === true,
    installing: installStartedAt !== null,
    log,
    elapsedMs,
    install,
    enableFast,
    disableFast: () => void act("fast/disable"),
    unload: () => void act("unload"),
    remove: () => void act("remove"),
    refresh,
  };
}
