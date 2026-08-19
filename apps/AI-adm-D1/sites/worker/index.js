/**
 * Minimal Sites adapter for the existing AI-adm-D1 Vite SPA.
 * The UI remains the Vite build; this worker only serves assets and keeps
 * client-side deep routes on the existing index.html entry point.
 *
 * It also proxies /api/admin/* to the fixed production Admin API origin so
 * the browser can complete same-origin login against this Sites domain
 * without weakening SameSite=Strict cookies or CSRF. The upstream origin is
 * a compile-time constant, never client-controlled.
 */
const ADMIN_API_UPSTREAM_ORIGIN = "https://admin-api.b827262.org";

// Headers that must not be copied across a hop (either direction). These are
// connection-scoped, not resource-scoped, and re-sending them corrupts the
// proxied response/request framing.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function copyHeaders(source, destination) {
  for (const [name, value] of source.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    destination.set(name, value);
  }
}

/**
 * Rewrite a single Set-Cookie value emitted by the upstream Admin API so it
 * is valid for the proxying Sites origin: strip any Domain attribute (the
 * upstream issues Domain=.b827262.org, which is the wrong trust boundary for
 * a *.chatgpt.site response) so the cookie becomes host-only for this Sites
 * domain. Every other attribute (HttpOnly, Secure, SameSite, Path, Max-Age /
 * Expires) and the cookie name/value are preserved byte-for-byte.
 */
function stripCookieDomain(setCookieValue) {
  return setCookieValue
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .join("; ");
}

async function proxyAdminApi(request) {
  const url = new URL(request.url);
  const upstreamUrl = new URL(url.pathname + url.search, ADMIN_API_UPSTREAM_ORIGIN);

  const upstreamHeaders = new Headers();
  copyHeaders(request.headers, upstreamHeaders);
  // The upstream origin is always ADMIN_API_UPSTREAM_ORIGIN above, regardless
  // of anything in the incoming request. Host and X-Forwarded-Host are
  // client-controlled and carry no routing authority here, so they are
  // dropped rather than forwarded, even though nothing downstream currently
  // trusts them.
  upstreamHeaders.delete("x-forwarded-host");
  upstreamHeaders.set("host", upstreamUrl.host);

  const hasBody = !["GET", "HEAD"].includes(request.method);

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: hasBody ? request.body : undefined,
    // Required by the Fetch spec whenever a streaming body is attached.
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual"
  });

  const upstreamResponse = await fetch(upstreamRequest);

  const responseHeaders = new Headers();
  copyHeaders(upstreamResponse.headers, responseHeaders);
  responseHeaders.delete("set-cookie");
  // getSetCookie() returns each Set-Cookie header individually; Headers
  // collapses repeated entries into one comma-joined string, which would
  // corrupt cookie parsing, so cookies are copied via append(), one per
  // value, after domain-stripping each one independently.
  for (const cookie of upstreamResponse.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", stripCookieDomain(cookie));
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
      return proxyAdminApi(request);
    }

    const isSpaRoute = request.method === "GET"
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/assets/")
      && !/\.[^/]+$/.test(url.pathname);

    if (isSpaRoute && url.pathname !== "/") {
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    if (url.pathname.startsWith("/api/")) return response;
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  },
};

export default worker;
