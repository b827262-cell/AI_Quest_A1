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
  // IPv6 literals arrive bracketed from URL parsing.
  if (host.includes(":")) {
    const raw = host.replace(/^\[|\]$/g, "").toLowerCase();
    const compact = raw === "::" ? "::" : raw;
    if (compact === "::1" || compact === "::") return false;
    if (/^f[cd][0-9a-f]{2}:/.test(compact)) return false; // unique-local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(compact)) return false; // link-local fe80::/10
    if (/^ff/.test(compact)) return false; // multicast
    const v4Tail = compact.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4Tail) return isAllowedPublicIpv4(v4Tail.slice(1).map(Number));
    return true;
  }
  return isAllowedPublicIpv4(host.split(".").map(Number));
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
  return true;
}
