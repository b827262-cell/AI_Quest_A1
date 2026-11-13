import { AiGatewayError, type AiProviderId } from "./ai-types";
import { pinnedFetch, type PinnedFetchOptions } from "../rag/pinned-fetch";
import { assertSafeLlmBaseUrl } from "../rag/safe-url";

/**
 * Transport used by every gateway provider to reach an admin-managed
 * endpoint. The default is {@link pinnedFetch}: static HTTPS/private-address
 * validation, a single DNS lookup whose result is validated and pinned to the
 * socket, a hard response-size cap and no redirect following.
 *
 * Tests inject a fake transport (see `setProviderTransportForTesting`) so they
 * never open a socket; production must not replace it.
 */
export type ProviderTransport = (
  url: string | URL,
  options: PinnedFetchOptions
) => Promise<Response>;

const PUBLIC_PROVIDER_MESSAGE = "AI 服務目前暫時無法使用，請稍後再試。";

let defaultTransport: ProviderTransport = pinnedFetch;

export function getProviderTransport(): ProviderTransport {
  return defaultTransport;
}

/**
 * Test-only seam: swap the network transport so unit/integration suites can
 * stub `fetch` without dialling a real host. Pass nothing to restore the
 * pinned production transport. Never call this from application code.
 */
export function setProviderTransportForTesting(transport?: ProviderTransport): void {
  defaultTransport = transport ?? pinnedFetch;
}

/**
 * Static, fail-closed SSRF check that runs BEFORE the provider credential is
 * attached to a request. It rejects non-HTTPS endpoints, credential-bearing
 * URLs, private/loopback/link-local/metadata IP literals, obfuscated IPs and
 * non-443 ports. The DNS/rebinding check happens in the pinned transport.
 *
 * Throws a stable `AI_PROVIDER_UNAVAILABLE` gateway error; the message only
 * carries the guard's reason code (never the URL, body or key).
 */
export function assertSafeProviderEndpoint(url: string | URL, providerId?: AiProviderId): URL {
  try {
    return assertSafeLlmBaseUrl(String(url));
  } catch (error) {
    const reasonCode = reasonCodeOf(error);
    throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
      internalMessage: `provider endpoint blocked: ${reasonCode}`,
      failedProvider: providerId,
      retryable: false,
      failureKind: "unknown"
    });
  }
}

/**
 * Maps a transport failure to the gateway's stable public error. SSRF-guard
 * rejections are never retried and never carry the upstream error; ordinary
 * network failures keep the previous retryable semantics.
 */
export function providerTransportFailure(
  error: unknown,
  providerId: AiProviderId,
  signal?: AbortSignal
): AiGatewayError {
  const reasonCode = reasonCodeOf(error);
  const blocked = reasonCode.startsWith("unsafe_");
  return new AiGatewayError("AI_PROVIDER_UNAVAILABLE", PUBLIC_PROVIDER_MESSAGE, {
    cause: blocked ? undefined : error,
    failedProvider: providerId,
    internalMessage: blocked ? `provider endpoint blocked: ${reasonCode}` : `${providerId} fetch failed`,
    retryable: blocked ? false : true,
    failureKind: signal?.aborted ? "provider_timeout" : "unknown"
  });
}

function reasonCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "reasonCode" in error) {
    const value = (error as { reasonCode?: unknown }).reasonCode;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "transport_error";
}
