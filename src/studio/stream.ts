import type { FastifyReply } from "fastify";

export type SendEvent = (event: unknown) => void;

/**
 * A long job answers with a stream of JSON events rather than one response at
 * the end, which is what makes honest progress possible. The whole job runs
 * inside, validation included: once this is entered every outcome — including
 * a rejected request — reaches the client as an event, never as a status code
 * the client is no longer listening for.
 */
export async function stream(reply: FastifyReply, job: (send: SendEvent) => Promise<void>): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const send: SendEvent = (event) => void reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    await job(send);
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
  reply.raw.end();
}
