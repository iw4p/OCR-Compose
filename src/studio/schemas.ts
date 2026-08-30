// Every shape the API accepts, in one place. Routes declare these and Fastify
// rejects a bad request before a handler runs — except where a route streams,
// which has to report its own failures (see `parse` below and `stream.ts`).
import { z } from "zod";
import { badRequest } from "./errors.js";

export const DocumentParams = z.object({ id: z.uuid() });

export const PageParams = z.object({ id: z.uuid(), page: z.coerce.number().int().positive() });

export const PageQuery = z.object({ scale: z.coerce.number().min(0.2).max(3).default(1) });

export const TestBody = z.object({ page: z.number().int().positive() });

export const ConvertBody = z.object({
  pages: z.array(z.number().int().positive()).min(1, "select at least one page"),
  title: z.string().optional(),
  author: z.string().optional(),
  language: z.string().default("en"),
});

/** Human-readable, one line: `pages: select at least one page`. */
const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");

/**
 * Validation a streaming route performs itself. Fastify's own schema check
 * would answer a bad body with a status code, which a client reading events
 * never sees — so those routes parse inside the stream instead.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(describeIssues(result.error));
  return result.data;
}
