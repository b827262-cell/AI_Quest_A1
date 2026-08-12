/**
 * Pinned-address outbound HTTP(S) transport for server-only LLM calls.
 *
 * Why this exists
 * ---------------
 * A naive "validate the URL, then call fetch(hostname)" has a DNS-rebinding /
 * TOCTOU hole: the security check does ONE DNS lookup, but the underlying
 * socket does a SECOND, independent lookup at connect time. An attacker who can
 * influence DNS can make the first lookup return a public IP (passes validation)
 * and the second return a private IP (the socket actually connects to it).
 *
 * This module eliminates that gap by making the validation lookup and the
 * connect lookup the SAME call: {@link resolveSafeAddress} returns the exact,
 * SSRF-checked IP(s), and the socket connects to exactly one of those IPs
 * (pinned), with the TLS handshake still verifying the ORIGINAL hostname
 * (SNI + certificate) so we cannot be MitM'd, and the HTTP `Host` header set to
 * the original hostname as the server expects.
 *
 * Security properties
 * -------------------
 * - TLS certificate verification stays ON (rejectUnauthorized: true).
 * - SNI = original hostname; the certificate must match the hostname, NOT the
 *   pinned IP.
 * - Host header = original hostname (required by virtual-hosted endpoints).
 * - If the pinned IP is private/loopback, resolveSafeAddress already threw
 *   before we ever opened a socket — but even defensively, an IP that is not in
 *   the validated set is never used.
 * - IPv4 and IPv6 are both supported (net/tls auto-select by address family).
 *
 * Only used on the server; importing in a browser bundle would fail at runtime
 * (node:net / node:tls / node:http are unavailable), which is acceptable because
 * this adapter is server-only.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { resolveSafeAddress, type DnsResolver } from "./safe-url";

export type PinnedFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Injectable DNS resolver used by resolveSafeAddress. */
  dnsResolver?: DnsResolver;
  /** Abort the request if no response within this many ms. */
  timeoutMs?: number;
};

/**
 * fetch-compatible transport that pins the validated destination address.
 *
 * @param url    The (already statically validated) request URL.
 * @param options request options. The `url` must already pass
 *                assertSafeLlmBaseUrl; this function performs the runtime
 *                DNS resolution + validation and pins the connection to the
 *                resulting address.
 */
export async function pinnedFetch(
  url: string | URL,
  options: PinnedFetchOptions = {}
): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;
  const isHttps = target.protocol === "https:";
  const port = target.port
    ? Number(target.port)
    : isHttps
      ? 443
      : 80;

  // SINGLE lookup: resolve + validate, and pin to exactly these addresses.
  const addresses = await resolveSafeAddress(target, { resolver: options.dnsResolver });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
  }

  try {
    return await new Promise<Response>((resolve, reject) => {
      const fail = (err: Error) => {
        cleanup();
        reject(toFetchError(err));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const requestOptions: http.RequestOptions = {
        method: options.method ?? "GET",
        // Keep the original hostname for SNI + Host header + cert verification.
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        headers: { ...(options.headers ?? {}), Host: target.hostname },
        createConnection: () => {
          const pinned = addresses[0];
          const isV6 = pinned.includes(":");
          // Connect DIRECTLY to the validated, SSRF-checked IP. There is no
          // second DNS lookup here — the socket dials `pinned` exactly. TLS
          // still verifies the certificate against `servername` (the ORIGINAL
          // hostname, not the IP), so MitM on the pinned IP is rejected and
          // SNI is correct for virtual-hosted endpoints.
          const sock = isHttps
            ? tls.connect(
                {
                  host: pinned,
                  port,
                  servername: target.hostname,
                  rejectUnauthorized: true
                },
                () => {
                  /* TLS established + cert verified against original hostname */
                }
              )
            : net.connect({ host: pinned, port, family: isV6 ? 6 : 4 });
          return sock;
        }
      };

      const req = isHttps
        ? https.request(requestOptions, (res) => handleResponse(res, resolve, cleanup))
        : http.request(requestOptions, (res) => handleResponse(res, resolve, cleanup));

      req.on("error", (err) => fail(err));
      controller.signal.addEventListener("abort", () => req.destroy(), { once: true });

      if (options.body) req.write(options.body);
      req.end();
    });
  } finally {
    /* nothing — cleanup handled inside promise */
  }
}

function handleResponse(
  res: http.IncomingMessage,
  resolve: (r: Response) => void,
  cleanup: () => void
): void {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
    cleanup();
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const status = res.statusCode ?? 0;
    // Mirror the Web `Response` interface closely enough for the adapter.
    const response = new Response(body, { status, headers });
    resolve(response);
  });
  res.on("error", (err) => {
    cleanup();
    throw toFetchError(err);
  });
}

function toFetchError(err: Error): Error {
  if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED" || (err as NodeJS.ErrnoException).code === "ENOTFOUND") {
    return new Error(`ssrf_pinned_connect_failed: ${err.message}`);
  }
  return err;
}
