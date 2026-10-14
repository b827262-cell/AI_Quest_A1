/** Server-only transport: resolve once, validate every address, dial the pinned IP.
 * TLS verifies the original hostname; redirects are returned to the adapter.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { assertSafeLlmBaseUrl, resolveSafeAddress, type DnsResolver } from "./safe-url";

export type PinnedFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  dnsResolver?: DnsResolver;
  /** Overall timeout including DNS and response consumption. */
  timeoutMs?: number;
};

export async function pinnedFetch(url: string | URL, options: PinnedFetchOptions = {}): Promise<Response> {
  const target = assertSafeLlmBaseUrl(String(url));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options.timeoutMs && options.timeoutMs > 0
    ? setTimeout(onAbort, options.timeoutMs) : undefined;
  const abortError = () => new DOMException("Request aborted", "AbortError");
  let cancelDns: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const addresses = await Promise.race([
      resolveSafeAddress(target, { resolver: options.dnsResolver }),
      new Promise<never>((_, reject) => {
        cancelDns = () => reject(abortError());
        controller.signal.addEventListener("abort", cancelDns, { once: true });
      })
    ]);
    if (cancelDns) controller.signal.removeEventListener("abort", cancelDns);
    controller.signal.throwIfAborted();
    return await new Promise<Response>((resolve, reject) => {
      let req: http.ClientRequest | undefined;
      const fail = (error: Error) => { req?.destroy(); reject(error); };
      const requestOptions: https.RequestOptions = {
        method: options.method ?? "GET",
        host: target.hostname,
        port: Number(target.port || 443),
        path: target.pathname + target.search,
        headers: { ...options.headers, Host: target.host },
        signal: controller.signal,
        // Do not set agent:false: Node would create an Agent and bypass this hook.
        createConnection: () => tls.connect({
          host: addresses[0],
          port: Number(target.port || 443),
          servername: target.hostname,
          rejectUnauthorized: true
        })
      };
      req = https.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("Upstream response aborted")));
        res.on("end", () => {
          try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headers.set(key, value);
              else if (Array.isArray(value)) headers.set(key, value.join(", "));
            }
            const status = res.statusCode ?? 502;
            const body = [204, 205, 304].includes(status) || options.method === "HEAD"
              ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, headers }));
          } catch (error) { fail(error as Error); }
        });
      });
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (cancelDns) controller.signal.removeEventListener("abort", cancelDns);
  }
}
