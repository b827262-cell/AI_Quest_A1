import { describe, expect, it } from "vitest";
import { assertSafeLlmBaseUrl } from "../../src/rag/server";

const UNSAFE: Array<[string, string]> = [
  ["http://api.cerebras.ai/v1", "non-HTTPS"],
  ["https://localhost/v1", "localhost"],
  ["https://foo.localhost/v1", "localhost suffix"],
  ["https://127.0.0.1/v1", "loopback"],
  ["https://127.5.6.7/v1", "loopback range"],
  ["https://[::1]/v1", "IPv6 loopback"],
  ["https://10.0.0.5/v1", "RFC1918 10/8"],
  ["https://172.16.0.9/v1", "RFC1918 172.16/12"],
  ["https://192.168.1.40/v1", "RFC1918 192.168/16"],
  ["https://169.254.169.254/latest/meta-data", "cloud metadata"],
  ["https://metadata.google.internal/computeMetadata", "GCP metadata host"],
  ["https://fe80::1/v1", "link-local IPv6"],
  ["https://user:pass@api.cerebras.ai/v1", "userinfo URL"],
  ["https://api.cerebras.ai:8080/v1", "non-allowlisted port"],
  ["https://api.cerebras.ai/v1#frag", "fragment"],
  ["https://2130706433/v1", "obfuscated decimal IP"],
  ["https://0x7f.1/v1", "obfuscated hex IP"],
  ["https://xn--e1afmkfd.xn--p1ai/v1", "punycode hostname"],
  ["https://api.cerebras.ai\\@evil.example/v1", "backslash smuggling"],
  ["", "empty string"],
  ["not a url", "unparseable"]
];

describe("Cerebras base URL SSRF guard", () => {
  for (const [value, label] of UNSAFE) {
    it(`fails closed: ${label}`, () => {
      expect(() => assertSafeLlmBaseUrl(value)).toThrowError(
        expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE" })
      );
      try {
        assertSafeLlmBaseUrl(value);
      } catch (error) {
        expect(String((error as { reasonCode?: string }).reasonCode)).toMatch(/^unsafe_base_url:/);
      }
    });
  }

  it("accepts the default Cerebras endpoint and HTTPS hosts without explicit port", () => {
    expect(assertSafeLlmBaseUrl("https://api.cerebras.ai/v1").toString()).toBe("https://api.cerebras.ai/v1");
    expect(assertSafeLlmBaseUrl("https://cerebras.test/v1/").toString()).toBe("https://cerebras.test/v1/");
  });

  it("accepts explicit 443 and configured allowlisted ports only", () => {
    // WHATWG URL normalizes the default HTTPS port away; both forms must pass.
    expect(assertSafeLlmBaseUrl("https://api.cerebras.ai:443/v1").pathname).toBe("/v1");
    expect(assertSafeLlmBaseUrl("https://api.cerebras.ai:8443/v1", { allowedPorts: [443, 8443] }).port).toBe("8443");
    expect(() => assertSafeLlmBaseUrl("https://api.cerebras.ai:8443/v1")).toThrow();
  });
});
