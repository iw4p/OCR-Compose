import { cpus, totalmem } from "node:os";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { installModel, modelStatus, removeModel, unloadModel } from "../../models/registry.js";
import { stream } from "../stream.js";

/** What the time estimates are actually measured on. */
const hardware = () => {
  const cores = cpus();
  return {
    cpu: cores[0]?.model.replace(/\s+/g, " ").trim() ?? "unknown CPU",
    cores: cores.length,
    memoryBytes: totalmem(),
    platform: `${process.platform}/${process.arch}`,
  };
};

export const modelRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/api/status", async () => ({ model: await modelStatus(), hardware: hardware() }));

  // Installing takes minutes and downloads gigabytes, so pip's own output is
  // streamed straight through rather than summarized at the end.
  app.post("/api/model/install", async (_request, reply) =>
    stream(reply, async (send) => {
      const message = await installModel((line) => send({ type: "log", line }));
      send({ type: "done", message });
    }),
  );

  app.post("/api/model/unload", async () => ({ message: await unloadModel(), model: await modelStatus() }));

  app.post("/api/model/remove", async () => ({ message: await removeModel(), model: await modelStatus() }));
};
