import { afterEach, describe, expect, it, vi } from "vitest";
import { CerebrasLlmProvider, type DnsResolver } from "../../src/rag/server";
import type { PinnedFetchOptions } from "../../src/rag/pinned-fetch";

afterEach(() => vi.restoreAllMocks());

const MOCK_DNS_RESOLVER: DnsResolver = async (_hostname: string) => ["8.8.8.8"];

type TransportFn = (url: string | URL, options?: PinnedFetchOptions) => Promise<Response>;

function provider(transport: TransportFn = defaultTransport, dnsResolver: DnsResolver = MOCK_DNS_RESOLVER): CerebrasLlmProvider {
  return new CerebrasLlmProvider({
    credentialResolver: async () => ({ apiKey: "cerebras-test-key-not-for-output" }),
    model: "gpt-oss-test",
    baseUrl: "https://cerebras.test/v1",
    transport,
    dnsResolver
  });
}

const defaultTransport: TransportFn = vi.fn(async (url: string | URL, options?: PinnedFetchOptions) => {
  const urlStr = String(url);
  expect(urlStr).toBe("https://cerebras.test/v1/chat/completions");
  const headers = (options?.headers as Record<string, string>) || {};
  expect(headers.Authorization).toBe("Bearer cerebras-test-key-not-for-output");
  const body = JSON.parse(String(options?.body)) as { model: string; messages: unknown[]; stream: boolean };
  expect(body).toMatchObject({ model: "gpt-oss-test", stream: false });
  expect(body.messages).toHaveLength(2);
  return new Response(JSON.stringify({
    model: "gpt-oss-test",
    choices: [{ message: { content: "{\"answer\":\"ok\",\"citations\":[],\"confidence\":\"low\"}" } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  }), { status: 200 });
});

describe("Cerebras RAG adapter", () => {
  it("fails closed at construction for unsafe base URLs (SSRF guard)", () => {
    const unsafe = ["http://api.cerebras.ai/v1", "https://127.0.0.1/v1", "https://169.254.169.254/", "https://localhost:443/v1", "https://u:p@api.cerebras.ai/v1"];
    for (const baseUrl of unsafe) {
      expect(() => new CerebrasLlmProvider({
        credentialResolver: async () => ({ apiKey: "cerebras-test-key-not-for-output" }),
        baseUrl
      })).toThrowError(expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE" }));
    }
  });

  it("maps the OpenAI-compatible success response to the neutral LLM port", async () => {
    const result = await provider().generate({
      requestId: "rag-success",
      systemPrompt: "system",
      userPrompt: "user",
      maxOutputTokens: 100
    });
    expect(result).toMatchObject({ text: "{\"answer\":\"ok\",\"citations\":[],\"confidence\":\"low\"}", model: "gpt-oss-test" });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });

  it("maps rate limits without exposing the upstream body or key", async () => {
    const rateLimitTransport: TransportFn = vi.fn(async () => new Response(JSON.stringify({ error: "cerebras-test-key-not-for-output" }), { status: 429 }));
    await expect(provider(rateLimitTransport).generate({
      requestId: "rag-rate-limit", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_RATE_LIMITED", retryable: true });
    try {
      await provider(rateLimitTransport).generate({ requestId: "rag-rate-limit-2", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("cerebras-test-key-not-for-output");
    }
  });

  it("maps an invalid JSON/content response fail-closed", async () => {
    const invalidJson: TransportFn = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
    await expect(provider(invalidJson).generate({
      requestId: "rag-invalid-json", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_INVALID_RESPONSE", retryable: false });

    const invalidShape: TransportFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }));
    await expect(provider(invalidShape).generate({
      requestId: "rag-invalid-shape", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_INVALID_RESPONSE" });
  });

  it("maps timeout and upstream failure to safe stable codes", async () => {
    const timeoutTransport: TransportFn = vi.fn(async (_url: string | URL, options?: PinnedFetchOptions) => new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("transport timeout")), { once: true });
    }));
    const timeoutProvider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: "timeout-test-key-not-for-output" }),
      timeoutMs: 100,
      transport: timeoutTransport,
      dnsResolver: MOCK_DNS_RESOLVER
    });
    await expect(timeoutProvider.generate({ requestId: "rag-timeout", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_TIMEOUT", failureKind: "timeout" });

    const serverError: TransportFn = vi.fn(async () => new Response("upstream private error", { status: 503 }));
    await expect(provider(serverError).generate({ requestId: "rag-503", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("requires a server credential resolver", async () => {
    const transport = vi.fn<TransportFn>();
    const unavailable = new CerebrasLlmProvider({ credentialResolver: async () => undefined, transport });
    await expect(unavailable.generate({ requestId: "rag-no-key", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_AUTH_FAILED" });
    expect(transport).not.toHaveBeenCalled();
  });
});
