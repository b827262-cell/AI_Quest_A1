import { isProductionEnvironment } from "../../db";

/**
 * Site topology. One commit is deployed to three Sites projects. Each project
 * declares its own role at runtime (SITE_ROLE / SITE_NAME), and each secondary
 * names the primary it proxies to (PRIMARY_ORIGIN). Nothing is inferred from
 * the hostname.
 *
 *   primary     (site "backend")         owns D1/R2 and serves every API locally.
 *   secondary   (site "student"/"admin") serves its pages itself and proxies only
 *                                        its own /api/<site>/* prefix to the primary.
 *   standalone  no SITE_ROLE declared     legacy local behaviour, nothing proxied.
 *   misconfigured SITE_ROLE/SITE_NAME set but inconsistent: API requests fail closed.
 */
export type SiteDeclaration =
  | { role: "standalone" | "misconfigured"; site: null; primaryOrigin: null }
  | { role: "primary"; site: "backend"; primaryOrigin: null }
  | { role: "secondary"; site: "student" | "admin"; primaryOrigin: string | null };

type SiteRuntime = Record<string, unknown> & { __env__?: Record<string, unknown> };

function declaredValue(name: string): string | undefined {
  const runtime = globalThis as unknown as SiteRuntime;
  const value = runtime[name] ?? runtime.__env__?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Normalizes PRIMARY_ORIGIN to a bare https origin. Anything else (http, a path,
 * embedded credentials, or a non-URL) yields null, so a secondary fails closed.
 */
function parsePrimaryOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.origin === value.replace(/\/$/, "")
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

/** Reads the declared topology. It is read per call, never cached, so runtime injection is picked up. */
export function readSiteDeclaration(): SiteDeclaration {
  const role = declaredValue("SITE_ROLE");
  const site = declaredValue("SITE_NAME");
  if (role === undefined && site === undefined) {
    return { role: "standalone", site: null, primaryOrigin: null };
  }
  if (role === "primary" && site === "backend") {
    return { role: "primary", site, primaryOrigin: null };
  }
  if (role === "secondary" && (site === "student" || site === "admin")) {
    return { role: "secondary", site, primaryOrigin: parsePrimaryOrigin(declaredValue("PRIMARY_ORIGIN")) };
  }
  return { role: "misconfigured", site: null, primaryOrigin: null };
}

/** A secondary answers and proxies only its own API prefix, for example /api/student/*. */
function isOwnApiPath(site: "student" | "admin", pathname: string): boolean {
  const prefix = `/api/${site}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Edge gate for /api/* requests. Returns a response when the request must not reach
 * a route handler, or null when it may proceed. /api/health stays readable on every
 * site so operators can inspect the declared topology.
 */
export function gateApiRequest(
  pathname: string,
  declared: SiteDeclaration = readSiteDeclaration()
): Response | null {
  if (pathname === "/api/health") return null;
  if (declared.role === "misconfigured") {
    return Response.json(
      { error: "site_misconfigured", message: "SITE_ROLE and SITE_NAME do not declare a valid site" },
      { status: 503 }
    );
  }
  if (declared.role === "secondary" && !isOwnApiPath(declared.site, pathname)) {
    return Response.json(
      { error: "not_found", message: "This path is not served by this site" },
      { status: 404 }
    );
  }
  return null;
}

export const ALLOWED_CORS_ORIGINS = [
  "https://ai-quest-a1-student.b827262.chatgpt.site",
  "https://ai-quest-a1-admin.b827262.chatgpt.site",
];

/**
 * Determines whether the current request should be delegated/proxied to the primary.
 * Only a secondary delegates, only for its own API prefix, and only in production.
 */
export function shouldDelegateToBackend(request: Request): boolean {
  const declared = readSiteDeclaration();
  if (declared.role !== "secondary") return false;
  if (!isProductionEnvironment()) return false;
  try {
    return isOwnApiPath(declared.site, new URL(request.url).pathname);
  } catch {
    return false;
  }
}

/**
 * Proxies a request from a secondary to the primary at the same API path. The
 * response is labelled `x-data-plane: primary`, so smoke tests can confirm that the
 * data came from the primary.
 */
export async function delegateToBackend(request: Request, path: string): Promise<Response> {
  const declared = readSiteDeclaration();
  if (declared.role !== "secondary" || declared.primaryOrigin === null) {
    return Response.json(
      {
        error: "backend_disabled",
        message: "PRIMARY_ORIGIN must be an https origin on a secondary site",
      },
      { status: 503 }
    );
  }

  const reqUrl = new URL(request.url);
  const backendTarget = new URL(path, declared.primaryOrigin);
  if (!isOwnApiPath(declared.site, backendTarget.pathname)) {
    return Response.json(
      { error: "not_found", message: "This path is not served by this site" },
      { status: 404 }
    );
  }
  backendTarget.search = reqUrl.search;

  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (["host", "content-length", "cf-connecting-ip", "cf-ray"].includes(lowerKey)) continue;
    forwardHeaders.set(key, value);
  }

  // x-forwarded-for is intentionally not stripped, so the primary sees the client chain.
  forwardHeaders.set("x-forwarded-host", reqUrl.hostname);
  forwardHeaders.set("x-forwarded-proto", reqUrl.protocol.replace(":", ""));
  // Extension point: a signed relay header (x-a01-relay) for identity forwarding is
  // deliberately not implemented in this version. See docs/ops/three-site-runbook.md.

  let body: BodyInit | undefined = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  try {
    const backendResponse = await fetch(backendTarget.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body,
    });

    const responseHeaders = new Headers();
    backendResponse.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding", "connection"].includes(lowerKey)) {
        responseHeaders.set(key, value);
      }
    });

    responseHeaders.set("x-data-plane", "primary");

    const responseBody = await backendResponse.arrayBuffer();
    return new Response(responseBody, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return Response.json(
      {
        error: "backend_unavailable",
        message: "Primary site is unreachable",
        detail: (err as Error)?.message,
      },
      { status: 503 }
    );
  }
}

/**
 * Handle CORS validation and preflight on the Shared Backend.
 */
export function handleCors(request: Request): {
  isOptions: boolean;
  preflightResponse?: Response;
  corsHeaders: Record<string, string>;
  isAllowedOrigin: boolean;
} {
  const origin = request.headers.get("origin");
  const isProd = isProductionEnvironment();

  if (!origin) {
    return {
      isOptions: request.method === "OPTIONS",
      corsHeaders: {},
      isAllowedOrigin: true,
    };
  }

  const isAllowed =
    ALLOWED_CORS_ORIGINS.includes(origin) ||
    (!isProd && (origin.includes("localhost") || origin.includes("127.0.0.1")));

  if (request.method === "OPTIONS") {
    if (!isAllowed && isProd) {
      return {
        isOptions: true,
        preflightResponse: new Response("CORS Origin Forbidden", { status: 403 }),
        corsHeaders: {},
        isAllowedOrigin: false,
      };
    }
    return {
      isOptions: true,
      preflightResponse: new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, x-demo-mode, oai-authenticated-user-id, oai-authenticated-user-email, oai-authenticated-user-full-name, oai-authenticated-user-full-name-encoding, oai-authenticated-user-role",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      }),
      corsHeaders: {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      },
      isAllowedOrigin: isAllowed,
    };
  }

  if (!isAllowed && isProd) {
    return {
      isOptions: false,
      corsHeaders: {},
      isAllowedOrigin: false,
    };
  }

  return {
    isOptions: false,
    corsHeaders: {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    },
    isAllowedOrigin: true,
  };
}
