import {
  AiGatewayError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId
} from "../ai-types";
import type { GatewayAiProvider } from "../provider.interface";

const PUBLIC_PROVIDER_MESSAGE = "AI 服務目前暫時無法使用，請稍後再試。";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function failureKindForStatus(status: number): "provider_timeout" | "provider_rate_limit" | "provider_server_error" | "unknown" {
  if (status === 408) return "provider_timeout";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_server_error";
  return "unknown";
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * OpenAI Chat Completions provider. Uses the OpenAI-compatible REST surface
 * via `fetch` (no SDK). The API key lives only in the server runtime env and
 * is never bundled into any frontend (spec §11, §13.1).
 *
 * `isAvailable()` returns false when the key is unset, so the server still
 * boots and the router falls back to the next provider (spec §13.2, §13.3).
 */
export class OpenAiGatewayProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "openai";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = options?.apiKey;
    this.baseUrl = (options?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.defaultModel = options?.model ?? "gpt-4o-mini";
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    if (!this.apiKey) {
      throw new AiGatewayError(
        "AI_PROVIDER_UNAVAILABLE",
        PUBLIC_PROVIDER_MESSAGE,
        { internalMessage: "openai provider has no API key", failedProvider: "openai" }
      );
    }
    const startedAt = Date.now();
    const model = request.model ?? this.defaultModel;
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
    messages.push({ role: "user", content: request.prompt });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature ?? 0.4,
          max_tokens: request.maxOutputTokens,
          messages
        }),
        signal: request.signal
      });
    } catch (err) {
      throw new AiGatewayError(
        "AI_PROVIDER_UNAVAILABLE",
        PUBLIC_PROVIDER_MESSAGE,
        {
          cause: err,
          failedProvider: this.providerId,
          internalMessage: "openai fetch failed",
          retryable: true,
          failureKind: request.signal?.aborted ? "provider_timeout" : "unknown"
        }
      );
    }

    if (!res.ok) {
      // Consume but never persist/return the upstream body. It may contain a
      // provider key, request headers or an internal URL.
      await res.text().catch(() => undefined);
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
        internalMessage: `provider HTTP ${res.status}`,
        failedProvider: this.providerId,
        retryable: isRetryableStatus(res.status),
        upstreamStatus: res.status,
        failureKind: failureKindForStatus(res.status)
      });
    }

    let data: {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        // OpenAI prompt caching (subset of prompt_tokens).
        prompt_tokens_details?: { cached_tokens?: unknown };
        // OpenAI o-series reasoning tokens (subset of completion_tokens).
        completion_tokens_details?: { reasoning_tokens?: unknown };
      };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
        cause: err,
        internalMessage: "provider returned invalid JSON",
        failedProvider: this.providerId,
        retryable: false,
        failureKind: "stream_format"
      });
    }
    const answer = typeof data?.choices?.[0]?.message?.content === "string"
      ? data.choices[0].message.content.trim()
      : "";

    const inputTokens = tokenCount(data.usage?.prompt_tokens);
    const outputTokens = tokenCount(data.usage?.completion_tokens);
    const totalTokens = tokenCount(data.usage?.total_tokens);
    // Cached/reasoning are subsets of the totals above; never additive.
    const cachedInputTokens = tokenCount(data.usage?.prompt_tokens_details?.cached_tokens);
    const thinkingTokens = tokenCount(data.usage?.completion_tokens_details?.reasoning_tokens);

    const hasProviderUsage = totalTokens !== undefined;
    return {
      provider: this.providerId,
      model,
      answer,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      thinkingTokens,
      usageSource: hasProviderUsage ? "provider_response" : "system_estimated",
      latencyMs: Date.now() - startedAt,
      finishReason: data.choices?.[0]?.finish_reason,
      diagnostics: {
        provider: this.providerId,
        model,
        transport: "json",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        configuredMaxOutputTokens: request.maxOutputTokens,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        requestDurationMs: Date.now() - startedAt,
        streamEndedNormally: true,
        lastChunk: null
      }
    };
  }
}
