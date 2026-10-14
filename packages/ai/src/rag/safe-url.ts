import { isIP } from "node:net";
import { RagApplicationError } from "./errors";

/**
 * SSRF guard for outbound LLM endpoint URLs.
 *
 * The Cerebras adapter only ever talks to a validated HTTPS endpoint. This
 * guard fails closed on any input that could resolve to a loopback, private,
 * link-local or metadata address, that uses obfuscated IP encodings, that
 * embeds credentials, or that targets a non-allowlisted port. It is applied
 * at the adapter boundary even while the base URL is not UI-configurable.
 */

export type SafeLlmBaseUrlOptions = {
  /** Ports accepted when explicitly present. Default: HTTPS only (443). */
  allowedPorts?: readonly number[];
};

const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

const BLOCKED_HOSTNAMES: readonly string[] = [
  "localhost",
  "metadata.google.internal",
  "ip6-loopback",
  "ip6-localhost"
];

const BLOCKED_HOSTNAME_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal"
];

/** Fail-closed URL validation; throws RagApplicationError for unsafe input. */
export function assertSafeLlmBaseUrl(raw: unknown, options: SafeLlmBaseUrlOptions = {}): URL {
  const fail = (reasonCode: string): never => {
    throw new RagApplicationError({
      code: "RAG_PROVIDER_UNAVAILABLE",
      provider: "cerebras",
      failureKind: "unavailable",
      reasonCode: `unsafe_base_url:${reasonCode}`
    });
  };

  if (typeof raw !== "string") return fail("not_string");
  const value = raw.trim();
  if (value.length === 0 || value.length > 2_048) return fail("length");
  // Control characters, whitespace and backslashes enable parser
  // differential and DNS-rebinding style attacks.
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return fail("forbidden_characters");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("unparseable");
  }

  if (url.protocol !== "https:") return fail("not_https");
  if (url.username !== "" || url.password !== "") return fail("userinfo");
  if (url.hash !== "" || url.search !== "") return fail("fragment_or_query");

  const host = url.hostname.toLowerCase();
  if (host === "" || host.length > 253) return fail("hostname_length");
  if (BLOCKED_HOSTNAMES.includes(host)) return fail("blocked_hostname");
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return fail("blocked_hostname_suffix");

  // Only conservative DNS labels; rejects IDN homographs and punycode.
  if (!/^[a-z0-9.-]+$/.test(host)) return fail("hostname_charset");
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return fail("hostname_shape");

  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return fail("label_shape");
  // Punycode enables IDN homograph lookalikes of trusted endpoints.
  if (labels.some((label) => label.startsWith("xn--"))) return fail("punycode_hostname");

  if (isIpLiteral(host)) {
    if (!isAllowedPublicIp(host)) return fail("blocked_ip");
  } else if (labels.every((label) => /^[0-9]+$/.test(label))) {
    // Numeric-only hosts in non-canonical forms (e.g. 2130706433) are
    // obfuscated IP encodings.
    return fail("obfuscated_ip");
  }

  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (url.port !== "" && !allowedPorts.includes(Number(url.port))) return fail("port_not_allowed");

  return url;
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255 && (part === "0" || !part.startsWith("0")));
}

function isAllowedPublicIp(host: string): boolean {
  const raw = host.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(raw);
  if (family === 4) return isAllowedPublicIpv4(raw.split(".").map(Number));
  if (family !== 6) return false;
  try {
    // Canonicalize expanded and dotted IPv6 before classifying mapped addresses.
    const canonical = new URL(`https://[${raw}]/`).hostname.slice(1, -1);
    const [left, right = ""] = canonical.split("::");
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    const words = [...l, ...Array(8 - l.length - r.length).fill("0"), ...r].map(x => parseInt(x, 16));
    if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
      return isAllowedPublicIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
    }
    // Permit global unicast only; exclude special-use 2001::/23, documentation,
    // and 6to4 (which embeds an IPv4 destination).
    if ((words[0] & 0xe000) !== 0x2000) return false;
    if (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) return false;
    if (words[0] === 0x2002 || (words[0] === 0x3fff && words[1] < 0x1000)) return false;
    return true;
  } catch {
    // Scoped IPv6 (zone IDs) and uncanonicalizable answers fail closed.
    return false;
  }
}

function isAllowedPublicIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast + reserved
  // Reject non-routable / reserved ranges (RFC 6890)
  if (a === 192 && b === 0 && octets[2] === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return false; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && b >= 18 && b <= 19) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return false; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return false; // 203.0.113.0/24 TEST-NET-3
  return true;
}

// ---------------------------------------------------------------------------
// Runtime DNS resolution validation
// ---------------------------------------------------------------------------

/**
 * Injectable DNS resolver type. Returns the list of IP addresses a hostname
 * resolves to. Tests inject mock resolvers; production uses the default.
 */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/**
 * Runtime DNS resolution + IP validation.
 *
 * Resolves the hostname of a validated URL to concrete IP addresses and
 * rejects if ANY resolved address falls in a private, loopback, link-local,
 * metadata, multicast, or otherwise non-routable range. This closes the
 * unsafe-resolution gap left by static URL validation alone. DNS rebinding
 * protection additionally requires pinnedFetch to dial the returned address.
 *
 * For IPv6, the host is resolved per-label and each address is checked.
 * IPv4-mapped IPv6 addresses (::ffff:10.x) are unwrapped and checked.
 *
 * Throws RagApplicationError if any resolved address is unsafe, or if DNS
 * resolution itself fails (fail-closed — cannot verify destination is safe).
 */
export async function resolveAndCheckSafe(
  url: URL,
  options: { resolver?: DnsResolver } = {}
): Promise<void> {
  await resolveSafeAddress(url, options);
}

/**
 * Default DNS resolver using node:dns promises API.
 * Uses dynamic import to avoid hard dependency in browser contexts.
 */
async function defaultDnsResolver(hostname: string): Promise<string[]> {
  const nodeDns = await import("node:dns");
  const result = await nodeDns.promises.lookup(hostname, { all: true });
  return result.map((r: { address: string }) => r.address);
}

/**
 * Resolve a validated URL to its concrete, SSRF-checked IP addresses.
 *
 * This is the SINGLE source of truth for the destination address used by the
 * outbound connection: the runtime SSRF guard resolves + validates the IPs
 * here, and the pinned transport connects to exactly one of the returned
 * addresses. The connection's socket lookup and the security validation lookup
 * are therefore the SAME call — there is no second independent DNS lookup that
 * could return a different (private) IP after validation (DNS-rebinding/TOCTOU).
 *
 * - IP-literal hosts are returned as-is (after allowance check).
 * - Hostname hosts are resolved via the (injectable) resolver and every
 *   resolved address must be a public, routable IP or the call fails closed.
 *
 * Returns the validated address list. Throws RagApplicationError (fail-closed)
 * if any address is unsafe, resolution fails, or no addresses are returned.
 */
export async function resolveSafeAddress(
  url: URL,
  options: { resolver?: DnsResolver } = {}
): Promise<string[]> {
  const fail = (reasonCode: string): never => {
    throw new RagApplicationError({
      code: "RAG_PROVIDER_UNAVAILABLE",
      provider: "cerebras",
      failureKind: "unavailable",
      reasonCode: `unsafe_dns:${reasonCode}`
    });
  };

  const host = url.hostname;
  let resolved: string[];

  if (isIpLiteral(host)) {
    if (!isAllowedPublicIp(host)) return fail("resolved_ip_blocked");
    resolved = [host];
  } else {
    const resolver = options.resolver ?? defaultDnsResolver;
    try {
      resolved = await resolver(host);
    } catch {
      return fail("dns_resolution_failed");
    }
    if (resolved.length === 0) return fail("dns_no_addresses");
    for (const addr of resolved) {
      if (!isAllowedPublicIp(addr)) return fail("resolved_ip_blocked");
    }
  }
  return resolved;
}
