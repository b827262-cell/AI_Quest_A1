/**
 * Runtime SSRF adversarial suite for the Cerebras LLM provider.
 *
 * Coverage (R-4 remediation):
 *  - Static URL validation rejects private/loopback/metadata/non-HTTPS etc.
 *  - resolveSafeAddress (validation lookup) rejects unsafe resolved IPs.
 *  - pinnedFetch binds the VALIDATED address to the SOCKET: the validation
 *    lookup and the connection lookup are the SAME call, so a second DNS
 *    response cannot redirect the socket to a private IP (DNS-rebinding/TOCTOU
 *    closed). Tests spy on net/tls connect to prove connected host === validated.
 *  - Cross-origin redirects are rejected (credential not forwarded to an
 *    arbitrary redirected public host).
 *  - No real network egress: DNS resolvers and transports are injected mocks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { assertSafeLlmBaseUrl, resolveSafeAddress, type DnsResolver } from "../../src/rag/safe-url";
import { pinnedFetch } from "../../src/rag/pinned-fetch";
import { CerebrasLlmProvider } from "../../src/rag/cerebras.adapter";

afterEach(() => vi.restoreAllMocks());

const SAFE_KEY = "test-key-not-for-output";

// ---------------------------------------------------------------------------
// DNS resolvers
// ---------------------------------------------------------------------------
const safeDns: DnsResolver = async () => ["8.8.8.8"];
const loopbackDns: DnsResolver = async () => ["127.0.0.1"];
const privateDns: DnsResolver = async () => ["10.0.0.5"];
const metadataDns: DnsResolver = async () => ["169.254.169.254"];
const privateIpv6Dns: DnsResolver = async () => ["fd00::1"];
const ipv6LoopbackDns: DnsResolver = async () => ["::1"];
const ipv4MappedPrivateDns: DnsResolver = async () => ["::ffff:169.254.169.254"];
const mixedDns: DnsResolver = async () => ["8.8.8.8", "10.0.0.5"];
const failingDns: DnsResolver = async () => { throw new Error("dns down"); };
const emptyDns: DnsResolver = async () => [];

function seqDns(...addrs: string[]): DnsResolver {
  let i = 0;
  return async () => [addrs[Math.min(i++, addrs.length - 1)]];
}

// ---------------------------------------------------------------------------
// Helpers for fake HTTP responses
// ---------------------------------------------------------------------------
function fakeResponse(status: number, body: string): http.IncomingMessage {
  const res = new http.IncomingMessage(null as unknown as net.Socket);
  (res as any).statusCode = status;
  (res as any).headers = { "content-type": "application/json" };
  const origOn = res.on.bind(res);
  (res as any).on = (ev: string, fn: (chunk: any) => void) => {
    if (ev === "data") queueMicrotask(() => fn(Buffer.from(body)));
    if (ev === "end") queueMicrotask(fn);
    return res;
  };
  return res;
}

function spyHttpRequests() {
  const make = (status: number, body: string) => {
    const impl = (options: any, cb?: (res: http.IncomingMessage) => void) => {
      // Exercise createConnection so the pinned address is actually dialed
      // (and captured by the tls.connect/net.connect spies). The returned fake
      // socket has no real I/O — that's fine, we only assert on the host.
      if (typeof options?.createConnection === "function") {
        try { options.createConnection(); } catch { /* ignore */ }
      }
      const res = fakeResponse(status, body);
      queueMicrotask(() => cb && cb(res));
      const req: any = new EventEmitter();
      req.end = () => {};
      req.write = () => {};
      req.destroy = () => {};
      return req;
    };
    return vi.fn(impl);
  };
  const httpSpy = vi.spyOn(http, "request").mockImplementation(make(200, "{}") as any);
  const httpsSpy = vi.spyOn(https, "request").mockImplementation(make(200, "{}") as any);
  return { httpSpy, httpsSpy, setBody: (status: number, body: string) => {
    httpSpy.mockImplementation(make(status, body) as any);
    httpsSpy.mockImplementation(make(status, body) as any);
  } };
}

function spyConnect() {
  const connects: Array<{ host: string; port: number; servername?: string }> = [];
  const tlsSpy = vi
    .spyOn(tls, "connect")
    .mockImplementation((opts: any, cb?: any) => {
      connects.push({ host: opts.host, port: opts.port, servername: opts.servername });
      const sock: any = new EventEmitter();
      sock.destroy = () => {};
      sock.on = () => sock;
      if (typeof cb === "function") queueMicrotask(cb);
      return sock as unknown as tls.TLSSocket;
    });
  const netSpy = vi
    .spyOn(net, "connect")
    .mockImplementation((opts: any, cb?: any) => {
      connects.push({ host: opts.host, port: opts.port });
      const sock: any = new EventEmitter();
      sock.destroy = () => {};
      sock.on = () => sock;
      if (typeof cb === "function") queueMicrotask(cb);
      return sock as unknown as net.Socket;
    });
  return { connects, tlsSpy, netSpy };
}

// ---------------------------------------------------------------------------
// Static URL validation
// ---------------------------------------------------------------------------
describe("SSRF adversarial — static URL validation", () => {
  const REJECT = [
    ["https://127.0.0.1/v1", "loopback"],
    ["https://localhost/v1", "localhost"],
    ["https://10.0.0.1/v1", "rfc1918-10"],
    ["https://172.16.0.1/v1", "rfc1918-172"],
    ["https://192.168.1.1/v1", "rfc1918-192"],
    ["https://169.254.169.254/v1", "metadata"],
    ["https://100.64.0.1/v1", "cgn"],
    ["https://[::1]/v1", "ipv6-loopback"],
    ["https://[fc00::1]/v1", "ipv6-ula"],
    ["https://[fe80::1]/v1", "ipv6-linklocal"],
    ["https://[::ffff:169.254.169.254]/v1", "ipv4-mapped"],
    ["https://user:pass@api.cerebras.ai/v1", "userinfo"],
    ["http://api.cerebras.ai/v1", "non-https"],
    ["https://api.cerebras.ai:8080/v1", "bad-port"],
    ["https://2130706433/v1", "decimal-ip"],
    ["https://0x7f.1/v1", "hex-ip"],
    ["https://xn--e1afmkfd.xn--p1ai/v1", "punycode"]
  ];
  for (const [url, label] of REJECT) {
    it(`rejects: ${label} (${url})`, () => {
      expect(() => assertSafeLlmBaseUrl(url)).toThrowError(
        expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE" })
      );
    });
  }
  it("allows: public https endpoint", () => {
    const u = assertSafeLlmBaseUrl("https://api.cerebras.ai/v1");
    expect(u.hostname).toBe("api.cerebras.ai");
  });
});

// ---------------------------------------------------------------------------
// Runtime DNS resolution validation
// ---------------------------------------------------------------------------
describe("SSRF adversarial — resolveSafeAddress (validation lookup)", () => {
  const base = new URL("https://cerebras-valid.example/v1");
  const cases: Array<[string, DnsResolver, string]> = [
    ["loopback", loopbackDns, "unsafe_dns:resolved_ip_blocked"],
    ["private", privateDns, "unsafe_dns:resolved_ip_blocked"],
    ["metadata", metadataDns, "unsafe_dns:resolved_ip_blocked"],
    ["ipv6-private", privateIpv6Dns, "unsafe_dns:resolved_ip_blocked"],
    ["ipv6-loopback", ipv6LoopbackDns, "unsafe_dns:resolved_ip_blocked"],
    ["ipv4-mapped", ipv4MappedPrivateDns, "unsafe_dns:resolved_ip_blocked"],
    ["mixed", mixedDns, "unsafe_dns:resolved_ip_blocked"],
    ["dns-fail", failingDns, "unsafe_dns:dns_resolution_failed"],
    ["dns-empty", emptyDns, "unsafe_dns:dns_no_addresses"]
  ];
  for (const [label, resolver, reason] of cases) {
    it(`rejects: ${label}`, async () => {
      await expect(resolveSafeAddress(base, { resolver })).rejects.toThrowError(
        expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE", reasonCode: reason })
      );
    });
  }
  it("allows: public IP", async () => {
    await expect(resolveSafeAddress(base, { resolver: safeDns })).resolves.toEqual(["8.8.8.8"]);
  });
});

// ---------------------------------------------------------------------------
// P1 / P2: pinnedFetch binds validated address to the socket (TOCTOU proof)
// ---------------------------------------------------------------------------
describe("SSRF adversarial — pinnedFetch address binding (DNS-rebinding/TOCTOU)", () => {
  it("connects to the VALIDATED public IP (validation==connection lookup)", async () => {
    const { connects } = spyConnect();
    spyHttpRequests();
    const res = await pinnedFetch("https://cerebras-valid.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SAFE_KEY}` },
      body: "{}",
      dnsResolver: safeDns
    });
    expect(res.status).toBe(200);
    expect(connects).toHaveLength(1);
    expect(connects[0].host).toBe("8.8.8.8");
  });

  it("NEVER connects when DNS resolves to a private IP (fail-closed, no socket)", async () => {
    const { connects } = spyConnect();
    spyHttpRequests();
    await expect(
      pinnedFetch("https://cerebras-valid.example/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${SAFE_KEY}` },
        body: "{}",
        dnsResolver: privateDns
      })
    ).rejects.toThrowError(
      expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE", reasonCode: "unsafe_dns:resolved_ip_blocked" })
    );
    expect(connects).toHaveLength(0);
  });

  it("rebinding (public→private) still connects only to the validated public IP", async () => {
    const { connects } = spyConnect();
    spyHttpRequests();
    const resolver = seqDns("8.8.8.8", "10.0.0.5");
    const res = await pinnedFetch("https://cerebras-valid.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SAFE_KEY}` },
      body: "{}",
      dnsResolver: resolver
    });
    expect(res.status).toBe(200);
    expect(connects).toHaveLength(1);
    expect(connects[0].host).toBe("8.8.8.8");
  });
});

// ---------------------------------------------------------------------------
// P2: provider-level DNS rebinding — fail-closed, no credential leakage
// ---------------------------------------------------------------------------
describe("SSRF adversarial — provider DNS rebinding (end-to-end)", () => {
  it("rejects when DNS resolves private at connect time; transport never called", async () => {
    const { connects } = spyConnect();
    spyHttpRequests();
    const provider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: SAFE_KEY }),
      baseUrl: "https://cerebras-valid.example/v1",
      // default transport = pinnedFetch (runs DNS validation)
      dnsResolver: loopbackDns
    });
    await expect(
      provider.generate({ requestId: "rb", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 })
    ).rejects.toThrowError(
      expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE", reasonCode: "unsafe_dns:resolved_ip_blocked" })
    );
    // resolveSafeAddress threw before any socket was opened.
    expect(connects).toHaveLength(0);
  });

  it("safe→private rebinding resolver: validation pins public; transport sees same-origin URL", async () => {
    const seen: string[] = [];
    const transport = vi.fn(async (url: string | URL, options?: any) => {
      seen.push(String(url));
      expect((options?.headers as any)?.Authorization).toBe(`Bearer ${SAFE_KEY}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
    }) as any;
    const provider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: SAFE_KEY }),
      baseUrl: "https://cerebras-valid.example/v1",
      transport,
      dnsResolver: seqDns("8.8.8.8", "10.0.0.5")
    });
    const out = await provider.generate({ requestId: "rb2", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 });
    expect(out.text).toBe("{\"ok\":true}");
    expect(seen[0]).toContain("cerebras-valid.example");
  });
});

// ---------------------------------------------------------------------------
// P3: cross-origin redirect credential policy
// ---------------------------------------------------------------------------
describe("SSRF adversarial — cross-origin redirect credential policy", () => {
  it("rejects cross-origin redirect (credential NOT forwarded to evil host)", async () => {
    let firstHopAuth = "";
    const transport = vi.fn(async (_url: string | URL, options?: any) => {
      firstHopAuth = (options?.headers as any)?.Authorization;
      return new Response(null, { status: 302, headers: { location: "https://evil-public.example/v1/other" } });
    }) as any;
    const provider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: SAFE_KEY }),
      baseUrl: "https://api.cerebras.ai/v1",
      transport,
      dnsResolver: safeDns
    });
    await expect(
      provider.generate({ requestId: "xo", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 })
    ).rejects.toThrowError(
      expect.objectContaining({ code: "RAG_PROVIDER_UNAVAILABLE", reasonCode: "unsafe_redirect:cross_origin" })
    );
    // Credential was sent on the first (same-origin) hop, but must NOT be
    // forwarded to a different origin.
    expect(firstHopAuth).toBe(`Bearer ${SAFE_KEY}`);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("same-origin redirect is permitted and re-validated", async () => {
    let hops = 0;
    const transport = vi.fn(async (_url: string | URL, options?: any) => {
      hops++;
      expect((options?.headers as any)?.Authorization).toBe(`Bearer ${SAFE_KEY}`);
      if (hops === 1) {
        return new Response(null, { status: 302, headers: { location: "https://api.cerebras.ai/v1/alt" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
    }) as any;
    const provider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: SAFE_KEY }),
      baseUrl: "https://api.cerebras.ai/v1",
      transport,
      dnsResolver: safeDns
    });
    const out = await provider.generate({ requestId: "so", systemPrompt: "s", userPrompt: "u", maxOutputTokens: 5 });
    expect(out.text).toBe("{\"ok\":true}");
    expect(hops).toBe(2);
  });
});
