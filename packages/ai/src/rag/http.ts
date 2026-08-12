import { parseRagRequest, type RagErrorResponse, type RagResponse } from "./contracts";
import { RagApplicationError, asRagApplicationError } from "./errors";
import type { RagApplication } from "./ports";

export type RagHttpRequest = {
  method: string;
  body: unknown;
  signal?: AbortSignal;
};

export type RagHttpResult = {
  status: number;
  body: RagResponse | RagErrorResponse;
};

/** Framework-neutral route adapter; Express/Hono wiring stays in the app. */
export function createRagHttpHandler(application: RagApplication) {
  return async function handle(request: RagHttpRequest): Promise<RagHttpResult> {
    let requestId: string | undefined;
    try {
      if (request.method.toUpperCase() !== "POST") {
        throw new RagApplicationError({ code: "RAG_INVALID_REQUEST" });
      }
      const parsed = parseRagRequest({ ...(request.body as Record<string, unknown>), contractVersion: 1 });
      requestId = parsed.requestId;
      return { status: 200, body: await application.answer(parsed, request.signal) };
    } catch (error) {
      const safeError = asRagApplicationError(error);
      return { status: safeError.httpStatus, body: safeError.toResponse(requestId) };
    }
  };
}
