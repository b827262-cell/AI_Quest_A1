/** Server-only transport: resolve once, validate every address, dial the pinned IP.
 * TLS verifies the original hostname; redirects are returned to the adapter.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { assertSafeLlmBaseUrl, resolveSafeAddress, type DnsResolver } from "./safe-url";

/** Conservative cap for one non-streaming LLM JSON response (4 MiB). */
export const MAX_LLM_RESPONSE_BYTES = 4 * 1024 * 1024;

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
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        req?.destroy();
      };
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
        let bytes = 0;
        const tooLarge = () => {
          fail(new Error("LLM response exceeds 4 MiB limit"));
          res.destroy();
        };
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("Upstream response aborted")));
        const declaredLength = res.headers["content-length"];
        if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength)
          && Number(declaredLength) > MAX_LLM_RESPONSE_BYTES) {
          tooLarge();
          return;
        }
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > MAX_LLM_RESPONSE_BYTES) { tooLarge(); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headers.set(key, value);
              else if (Array.isArray(value)) headers.set(key, value.join(", "));
            }
            const status = res.statusCode ?? 502;
            const body = [204, 205, 304].includes(status) || options.method === "HEAD"
              ? null : Buffer.concat(chunks);
            const response = new Response(body, { status, headers });
            settled = true;
            resolve(response);
          } catch (error) { fail(error as Error); }
        });
      });
      req.on("error", fail);
      if (options.body) req.write(options.body);
      req.end();
    });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (cancelDns) controller.signal.removeEventListener("abort", cancelDns);
  }
}
