/**
 * Fastify serializes any thrown error carrying `statusCode` with that status,
 * so a handler says what went wrong by throwing, never by juggling replies.
 */
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const badRequest = (message: string) => httpError(400, message);
export const notFound = (message: string) => httpError(404, message);
