// The Studio's local HTTP server: a Fastify app with two route plugins and the
// built UI served alongside them. Routing, validation and error status codes
// are the framework's job; everything specific to OCR Compose lives in
// `routes/`, `documents.ts` and `schemas.ts`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { documentRoutes } from "./routes/documents.js";
import { modelRoutes } from "./routes/model.js";

const staticRoot = fileURLToPath(new URL("../../studio/dist/", import.meta.url));

export function buildStudio() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // An upload is a raw PDF, not a form: keep the bytes exactly as sent.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  // One error shape for the whole API, so the client never has to guess.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = hasZodFastifySchemaValidationErrors(error)
      ? 400
      : (error.statusCode ?? (error.validation ? 400 : 500));
    void reply.status(status).send({ error: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: `no route for ${request.method} ${request.url}` });
  });

  void app.register(modelRoutes);
  void app.register(documentRoutes);

  // Absent until `npm run studio:build` has run — which `npm run studio` does,
  // but a test or a bare API run does not, and that must not be fatal.
  if (existsSync(staticRoot)) void app.register(fastifyStatic, { root: staticRoot, index: "index.html" });

  return app;
}

export async function startStudio(options: { host?: string; port?: number } = {}) {
  const app = buildStudio();
  const url = await app.listen({ port: options.port ?? 4173, host: options.host ?? "127.0.0.1" });
  return { app, url };
}
