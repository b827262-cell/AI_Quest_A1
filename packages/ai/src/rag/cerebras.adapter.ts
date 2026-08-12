import { RagApplicationError } from "./errors";
import { assertSafeLlmBaseUrl } from "./safe-url";
import type {
  LlmGenerateInput,
  LlmGenerateOutput,
  LlmProvider,
  ServerCredentialResolver
} from "./ports";

export type CerebrasAdapterOptions = {
  credentialResolver: ServerCredentialResolver;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type CerebrasResponse = {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
};

/**
 * Server-only Cerebras Chat Completions adapter. No SDK or wire shape escapes
 * this file; the API key is resolved just-in-time and is never stored on the
 * adapter instance or included in an error/log/response.
 */
export class CerebrasLlmProvider implements LlmProvider {
  readonly providerId = "cerebras" as const;
  readonly defaultModel: string;
  private readonly credentialResolver: ServerCredentialResolver;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CerebrasAdapterOptions) {
    this.credentialResolver = options.credentialResolver;
    this.defaultModel = options.model ?? "gpt-oss-120b";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.cerebras.ai/v1");
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? 15_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    let credential;
    try {
      credential = await this.credentialResolver("cerebras");
    } catch {
      throw new RagApplicationError({ code: "RAG_PROVIDER_AUTH_FAILED", provider: "cerebras", failureKind: "auth_failed" });
    }
    if (!credential?.apiKey?.trim()) {
      throw new RagApplicationError({ code: "RAG_PROVIDER_AUTH_FAILED", provider: "cerebras", failureKind: "auth_failed" });
    }

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const abortFromCaller = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.apiKey}`
        },
        body: JSON.stringify({
          model: input.model ?? this.defaultModel,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt }
          ],
          temperature: input.temperature ?? 0.1,
          max_tokens: input.maxOutputTokens,
          stream: false
        }),
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_AUTH_FAILED", provider: "cerebras", failureKind: "auth_failed" });
      }
      if (response.status === 429) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_RATE_LIMITED", retryable: true, provider: "cerebras", failureKind: "rate_limited" });
      }
      if (response.status === 408 || response.status === 504) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_TIMEOUT", retryable: true, provider: "cerebras", failureKind: "timeout" });
      }
      if (!response.ok) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_UNAVAILABLE", retryable: response.status >= 500, provider: "cerebras", failureKind: "unavailable" });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new RagApplicationError({ code: "RAG_PROVIDER_INVALID_RESPONSE", provider: "cerebras", failureKind: "invalid_response" });
      }
      const parsed = parseCerebrasResponse(payload);
      if (!parsed) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_INVALID_RESPONSE", provider: "cerebras", failureKind: "invalid_response" });
      }
      return {
        text: parsed.text,
        model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : (input.model ?? this.defaultModel),
        usage: parsed.usage,
        latencyMs: Date.now() - started
      };
    } catch (error) {
      if (error instanceof RagApplicationError) throw error;
      if (controller.signal.aborted) {
        throw new RagApplicationError({ code: "RAG_PROVIDER_TIMEOUT", retryable: true, provider: "cerebras", failureKind: "timeout" });
      }
      throw new RagApplicationError({ code: "RAG_PROVIDER_UNAVAILABLE", retryable: true, provider: "cerebras", failureKind: "unavailable" });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

/**
 * Fail closed at the adapter boundary: a base URL that does not pass the
 * SSRF guard prevents the adapter from being constructed at all.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const url = assertSafeLlmBaseUrl(baseUrl);
  return url.toString().replace(/\/$/, "");
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value >= 100 && value <= 120_000 ? Math.floor(value) : 15_000;
}

function parseCerebrasResponse(value: unknown): {
  text: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as CerebrasResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) return undefined;
  const usage = payload.usage ? {
    inputTokens: safeToken(payload.usage.prompt_tokens),
    outputTokens: safeToken(payload.usage.completion_tokens),
    totalTokens: safeToken(payload.usage.total_tokens)
  } : undefined;
  return { text: content.trim(), model: typeof payload.model === "string" ? payload.model : undefined, usage };
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
