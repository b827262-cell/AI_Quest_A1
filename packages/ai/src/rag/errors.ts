import {
  RAG_ERROR_HTTP_STATUS,
  RagContractValidationError,
  type RagErrorCode,
  type RagErrorResponse
} from "./contracts";
import type { RagProviderId } from "./ports";

const PUBLIC_MESSAGES: Readonly<Record<RagErrorCode, string>> = {
  RAG_INVALID_REQUEST: "RAG request is invalid.",
  RAG_INJECTION_BLOCKED: "The request was blocked by the safety policy.",
  RAG_NO_EVIDENCE: "No sufficient evidence was found.",
  RAG_CITATION_INVALID: "The provider response could not be safely verified.",
  RAG_PROVIDER_TIMEOUT: "The AI provider timed out. Please try again.",
  RAG_PROVIDER_RATE_LIMITED: "The AI provider is rate limited. Please try again later.",
  RAG_PROVIDER_INVALID_RESPONSE: "The AI provider returned an invalid response.",
  RAG_PROVIDER_AUTH_FAILED: "The AI provider is not available.",
  RAG_PROVIDER_UNAVAILABLE: "The AI provider is not available.",
  RAG_INTERNAL: "The RAG service could not complete the request."
};

export type RagFailureKind =
  | "timeout"
  | "rate_limited"
  | "invalid_response"
  | "auth_failed"
  | "unavailable";

/** Error carrying only stable, safe information. Raw upstream errors are not retained. */
export class RagApplicationError extends Error {
  readonly code: RagErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly provider?: RagProviderId;
  readonly failureKind?: RagFailureKind;
  readonly reasonCode?: string;

  constructor(input: {
    code: RagErrorCode;
    retryable?: boolean;
    provider?: RagProviderId;
    failureKind?: RagFailureKind;
    reasonCode?: string;
  }) {
    super(PUBLIC_MESSAGES[input.code]);
    this.name = "RagApplicationError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.httpStatus = RAG_ERROR_HTTP_STATUS[input.code];
    this.provider = input.provider;
    this.failureKind = input.failureKind;
    this.reasonCode = input.reasonCode;
  }

  toResponse(requestId?: string): RagErrorResponse {
    return {
      contractVersion: 1,
      requestId,
      error: { code: this.code, message: this.message, retryable: this.retryable }
    };
  }
}

export function asRagApplicationError(error: unknown): RagApplicationError {
  if (error instanceof RagApplicationError) return error;
  if (error instanceof RagContractValidationError) return new RagApplicationError({ code: "RAG_INVALID_REQUEST" });
  return new RagApplicationError({ code: "RAG_INTERNAL" });
}

export function isRagProviderError(error: unknown): error is RagApplicationError {
  return error instanceof RagApplicationError && Boolean(error.failureKind);
}
