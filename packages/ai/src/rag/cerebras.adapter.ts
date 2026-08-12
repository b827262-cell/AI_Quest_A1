import { RagApplicationError } from "./errors";
import { assertSafeLlmBaseUrl, type DnsResolver } from "./safe-url";
import { pinnedFetch } from "./pinned-fetch";
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
  /** Injectable DNS resolver for runtime SSRF validation. */
  dnsResolver?: DnsResolver;
  /**
   * Injectable pinned-address transport (default: pinnedFetch). Tests pass a
   * mock to assert on the validated URL / DNS resolver without real sockets.
   */
  transport?: typeof pinnedFetch;
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
  private readonly transport: typeof pinnedFetch;
  private readonly dnsResolver: DnsResolver | undefined;

  constructor(options: CerebrasAdapterOptions) {
    this.credentialResolver = options.credentialResolver;
    this.defaultModel = options.model ?? "gpt-oss-120b";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.cerebras.ai/v1");
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? 15_000);
    this.transport = options.transport ?? pinnedFetch;
    this.dnsResolver = options.dnsResolver;
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
      const response = await this.executeWithRedirectControl(
        `${this.baseUrl}/chat/completions`,
        credential.apiKey,
        input,
        controller.signal
      );

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

  /**
   * Execute the HTTP request with strict redirect control, runtime DNS
   * pinning, and cross-origin credential policy.
   *
   * Security properties (P1 / P3):
   *  - The connection uses {@link pinnedFetch}, which resolves + validates the
   *    destination IP ONCE (resolveSafeAddress) and connects to exactly that
   *    pinned address. The validation lookup and the connect lookup are the SAME
   *    call, so a second DNS response cannot redirect the socket to a private IP
   *    (DNS-rebinding / TOCTOU closed). TLS cert verification stays ON against
   *    the ORIGINAL hostname (SNI), so MitM on the pinned IP is rejected.
   *  - Static URL validation runs on every hop.
   *  - Cross-origin redirects are REJECTED: the Cerebras Authorization
   *    credential is only ever sent to the original, validated origin. A 3xx
   *    pointing to a different host is followed only for public, same-provider
   *    endpoints and the credential is NOT forwarded — in practice we reject
   *    cross-origin redirects fail-closed (see "unsafe_redirect:cross_origin").
   *  - The API key is NEVER sent to an unsafe redirect target.
   */
  private async executeWithRedirectControl(
    url: string,
    apiKey: string,
    input: LlmGenerateInput,
    signal: AbortSignal
  ): Promise<Response> {
    const maxRedirects = 5;
    const seenUrls = new Set<string>();
    let currentUrl = assertSafeLlmBaseUrl(url).toString();
    let previousOrigin: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const validatedUrl = assertSafeLlmBaseUrl(currentUrl);
      const origin = `${validatedUrl.protocol}//${validatedUrl.host}`;

      if (seenUrls.has(validatedUrl.toString())) {
        throw new RagApplicationError({
          code: "RAG_PROVIDER_UNAVAILABLE",
          provider: "cerebras",
          failureKind: "unavailable",
          reasonCode: "unsafe_redirect:loop"
        });
      }

      // P3: reject cross-origin redirects so the credential cannot leak to an
      // arbitrary redirected host. The very first hop has no "previous origin"
      // and is always allowed (it came from the validated base URL).
      if (previousOrigin !== undefined && origin !== previousOrigin) {
        throw new RagApplicationError({
          code: "RAG_PROVIDER_UNAVAILABLE",
          provider: "cerebras",
          failureKind: "unavailable",
          reasonCode: "unsafe_redirect:cross_origin"
        });
      }
      previousOrigin = origin;
      seenUrls.add(validatedUrl.toString());

      // Pinned, runtime-validated connection. resolveSafeAddress inside
      // this.transport resolves + validates once and the socket connects to
      // that exact address.
      const response = await this.transport(validatedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
        signal,
        dnsResolver: this.dnsResolver,
        timeoutMs: this.timeoutMs
      });

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      if (seenUrls.size > maxRedirects) {
        throw new RagApplicationError({
          code: "RAG_PROVIDER_UNAVAILABLE",
          provider: "cerebras",
          failureKind: "unavailable",
          reasonCode: "unsafe_redirect:too_many"
        });
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new RagApplicationError({
          code: "RAG_PROVIDER_UNAVAILABLE",
          provider: "cerebras",
          failureKind: "unavailable",
          reasonCode: "unsafe_redirect:missing_location"
        });
      }

      // Validate the redirect target statically (and, on the next loop
      // iteration, via pinnedFetch). Cross-origin is rejected above.
      currentUrl = new URL(location, currentUrl).toString();
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
