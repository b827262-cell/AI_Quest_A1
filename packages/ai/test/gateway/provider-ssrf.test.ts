import { afterEach, describe, expect, it, vi } from "vitest";
import https from "node:https";
import {
  GeminiGatewayProvider,
  KimiGatewayProvider,
  OpenAiGatewayProvider,
  QwenGatewayProvider,
  ZaiGatewayProvider,
  setProviderTransportForTesting,
  type ProviderTransport
} from "../../src";
import type { DnsResolver } from "../../src/rag/safe-url";

/**
 * Admin-managed provider endpoints are SSRF-guarded at two layers:
 *  1. a static check that runs before the credential is attached, and
 *  2. the pinned transport (DNS lookup validated once, socket bound to it,
 *     4 MiB response cap, no redirect following).
 *
 * These tests never open a socket: the static layer is exercised with a spy
 * transport, the DNS layer with an injected resolver on the real transport.
 */

const SECRET_KEY = "sk-ssrf-guard-test-key-0123456789";

afterEach(() => {
  setProviderTransportForTesting();
  vi.restoreAllMocks();
});

type ProviderFactory = (options: {
  apiKey: string;
  baseUrl: string;
  transport?: ProviderTransport;
  dnsResolver?: DnsResolver;
}) => { generate: (request: { requestId: string; prompt: string }) => Promise<unknown> };

const factories: Array<[string, ProviderFactory]> = [
  ["openai", (options) => new OpenAiGatewayProvider(options)],
  ["gemini", (options) => new GeminiGatewayProvider(options)],
  ["kimi", (options) => new KimiGatewayProvider(options)],
  ["qwen", (options) => new QwenGatewayProvider(options)],
  ["zai", (options) => new ZaiGatewayProvider(options)]
];

const unsafeBaseUrls = [
  "http://api.provider.example/v1",
  "https://127.0.0.1/v1",
  "https://10.0.0.5/v1",
  "https://172.16.0.10/v1",
  "https://192.168.1.10/v1",
  "https://169.254.169.254/latest/meta-data",
  "https://[::1]/v1",
  "https://metadata.google.internal/v1",
  "https://2130706433/v1"
];

function spyTransport(): { transport: ProviderTransport; calls: Array<{ url: string; options: unknown }> } {
  const calls: Array<{ url: string; options: unknown }> = [];
  return {
    calls,
    transport: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ choices: [{ message: { content: "leak" } }] }), { status: 200 });
    }
  };
}

describe("admin-managed provider baseUrl SSRF guard", () => {
  it.each(factories.flatMap(([name, make]) => unsafeBaseUrls.map((baseUrl) => [name, make, baseUrl] as const)))(
    "%s blocks %s before the transport (and credential) is used",
    async (name, make, baseUrl) => {
      const { transport, calls } = spyTransport();
      const provider = make({ apiKey: SECRET_KEY, baseUrl, transport });

      let thrown: unknown;
      try {
        await provider.generate({ requestId: `ssrf-${name}`, prompt: "hello" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", failedProvider: name });
      expect(calls).toHaveLength(0);
      const serialized = JSON.stringify(thrown);
      expect(serialized).not.toContain(SECRET_KEY);
      expect(serialized).not.toContain("api.provider.example");
    }
  );

  it("rejects a public hostname whose DNS answer is a private address (real pinned transport)", async () => {
    const requestSpy = vi.spyOn(https, "request");
    const provider = new OpenAiGatewayProvider({
      apiKey: SECRET_KEY,
      baseUrl: "https://public-but-evil.example/v1",
      dnsResolver: async () => ["10.0.0.5"]
    });

    await expect(provider.generate({ requestId: "dns-ssrf", prompt: "hello" })).rejects.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      failedProvider: "openai"
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("does not follow redirects, so the key never reaches the Location host", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const transport: ProviderTransport = async (url, options) => {
      const headers = options.headers as Record<string, string> | undefined;
      seen.push({ url: String(url), authorization: headers?.Authorization });
      return new Response("", {
        status: 302,
        headers: { location: "https://attacker.example/collect" }
      });
    };
    const provider = new OpenAiGatewayProvider({ apiKey: SECRET_KEY, baseUrl: "https://api.openai.com/v1", transport });

    await expect(provider.generate({ requestId: "redirect", prompt: "hello" })).rejects.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE"
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0].authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(seen.some((call) => call.url.includes("attacker.example"))).toBe(false);
  });

  it("never returns the upstream body or the key in the error", async () => {
    const transport: ProviderTransport = async () =>
      new Response(JSON.stringify({ error: "bad key sk-upstream-body-secret" }), { status: 500 });
    const provider = new OpenAiGatewayProvider({ apiKey: SECRET_KEY, baseUrl: "https://api.openai.com/v1", transport });

    let thrown: unknown;
    try {
      await provider.generate({ requestId: "leak", prompt: "hello" });
    } catch (error) {
      thrown = error;
    }
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain("sk-upstream-body-secret");
  });

  it("still sends the auth contract to a safe endpoint", async () => {
    let authorization: string | undefined;
    const transport: ProviderTransport = async (_url, options) => {
      authorization = (options.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    };
    const provider = new OpenAiGatewayProvider({ apiKey: SECRET_KEY, baseUrl: "https://api.openai.com/v1", transport });

    await expect(provider.generate({ requestId: "ok", prompt: "hello" })).resolves.toMatchObject({ answer: "OK" });
    expect(authorization).toBe(`Bearer ${SECRET_KEY}`);
  });
});
