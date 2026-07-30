import {
  AiGatewayError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId
} from "../ai-types";
import type { GatewayAiProvider } from "../provider.interface";

const PUBLIC_PROVIDER_MESSAGE = "AI 服務目前暫時無法使用，請稍後再試。";

export type GeminiEndpointProfile =
  | "gemini_native"
  | "gemini_openai_compatible";

export const DEFAULT_GEMINI_ENDPOINT_PROFILE: GeminiEndpointProfile = "gemini_native";

export function isGeminiEndpointProfile(value: string | undefined): value is GeminiEndpointProfile {
  return value === "gemini_native" || value === "gemini_openai_compatible";
}

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

function cleanBaseUrl(value: string): string {
  // Provider configuration is server-side, but query strings are never part
  // of the authentication contract. Strip them before constructing a URL.
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.split(/[?#]/, 1)[0].replace(/\/$/, "");
  }
}

function compatibleBaseUrl(value: string): string {
  return value.endsWith("/openai") ? value : `${value}/openai`;
}

/**
 * Gemini provider using the Google Generative Language REST API (`generateContent`).
 * No SDK; key is server-runtime only. Unavailable when the key is unset.
 */
export class GeminiGatewayProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "gemini";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly endpointProfile: GeminiEndpointProfile;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    endpointProfile?: GeminiEndpointProfile;
  }) {
    this.apiKey = options?.apiKey;
    this.baseUrl = cleanBaseUrl(
      options?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    );
    this.endpointProfile = options?.endpointProfile ?? DEFAULT_GEMINI_ENDPOINT_PROFILE;
    this.defaultModel = options?.model ?? "gemini-1.5-flash";
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    if (!this.apiKey) {
      throw new AiGatewayError(
        "AI_PROVIDER_UNAVAILABLE",
        PUBLIC_PROVIDER_MESSAGE,
        { internalMessage: "gemini provider has no API key", failedProvider: "gemini" }
      );
    }
    const startedAt = Date.now();
    const model = request.model ?? this.defaultModel;

    if (!isGeminiEndpointProfile(this.endpointProfile)) {
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
        failedProvider: "gemini",
        internalMessage: "invalid Gemini endpoint profile"
      });
    }

    const isCompatible = this.endpointProfile === "gemini_openai_compatible";
    const body: Record<string, unknown> = isCompatible
      ? {
          model,
          temperature: request.temperature ?? 0.4,
          max_tokens: request.maxOutputTokens,
          messages: [
            ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
            { role: "user", content: request.prompt }
          ]
        }
      : {
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.4,
            maxOutputTokens: request.maxOutputTokens
          }
        };
    if (!isCompatible && request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    const endpoint = isCompatible
      ? `${compatibleBaseUrl(this.baseUrl)}/chat/completions`
      : `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isCompatible) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      headers["x-goog-api-key"] = this.apiKey;
    }

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal
      });
    } catch (err) {
      throw new AiGatewayError(
        "AI_PROVIDER_UNAVAILABLE",
        PUBLIC_PROVIDER_MESSAGE,
        {
          cause: err,
          failedProvider: "gemini",
          internalMessage: "gemini fetch failed",
          retryable: true,
          failureKind: request.signal?.aborted ? "provider_timeout" : "unknown"
        }
      );
    }

    if (!res.ok) {
      await res.text().catch(() => undefined);
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
        internalMessage: `provider HTTP ${res.status}`,
        failedProvider: "gemini",
        retryable: isRetryableStatus(res.status),
        upstreamStatus: res.status,
        failureKind: failureKindForStatus(res.status)
      });
    }

    let data: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        // Gemini 2.5+: tokens served from the implicit/explicit context cache.
        cachedContentTokenCount?: number;
        // Gemini 2.5+ thinking models: reasoning tokens (subset of candidates).
        thoughtsTokenCount?: number;
      };
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
        cause: err,
        internalMessage: "provider returned invalid JSON",
        failedProvider: "gemini",
        retryable: false,
        failureKind: "stream_format"
      });
    }
    const answer = isCompatible
      ? (typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "").trim()
      : (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();

    const promptTokens = isCompatible
      ? tokenCount(data.usage?.prompt_tokens)
      : tokenCount(data.usageMetadata?.promptTokenCount);
    const candidatesTokens = isCompatible
      ? tokenCount(data.usage?.completion_tokens)
      : tokenCount(data.usageMetadata?.candidatesTokenCount);
    const totalTokens = isCompatible
      ? tokenCount(data.usage?.total_tokens)
      : tokenCount(data.usageMetadata?.totalTokenCount);
    const cachedInputTokens = isCompatible ? undefined : tokenCount(data.usageMetadata?.cachedContentTokenCount);
    const thinkingTokens = isCompatible ? undefined : tokenCount(data.usageMetadata?.thoughtsTokenCount);

    const hasProviderUsage = totalTokens !== undefined;
      return {
      provider: "gemini",
      model,
      answer,
      inputTokens: promptTokens,
      outputTokens: candidatesTokens,
      totalTokens,
      // Gemini usageMetadata fields:
      //   promptTokenCount — total input tokens (includes cachedContentTokenCount)
      //   candidatesTokenCount — candidate output tokens (separate from thoughtsTokenCount)
      //   cachedContentTokenCount — cached input tokens (subset of promptTokenCount)
      //   thoughtsTokenCount — thinking/reasoning tokens (separate from candidatesTokenCount)
      //   totalTokenCount — provider-reported total (promptTokenCount + candidatesTokenCount)
      // The gateway treats thinking tokens as separate for billing (billedOutput = output + thinking).
      cachedInputTokens,
      thinkingTokens,
      usageSource: hasProviderUsage ? "provider_response" : "system_estimated",
      latencyMs: Date.now() - startedAt,
      finishReason: isCompatible ? data.choices?.[0]?.finish_reason : data.candidates?.[0]?.finishReason,
      diagnostics: {
        provider: this.providerId,
        model,
        transport: "json",
        promptTokens,
        completionTokens: candidatesTokens,
        configuredMaxOutputTokens: request.maxOutputTokens,
        finishReason: (isCompatible ? data.choices?.[0]?.finish_reason : data.candidates?.[0]?.finishReason) ?? null,
        requestDurationMs: Date.now() - startedAt,
        streamEndedNormally: true,
        lastChunk: null
      }
    };
  }
}
