import { isProductionEnvironment } from "../../db";

type RuntimeEnvironment = { STAGING_BACKEND_ORIGIN?: string };

/**
 * This staging build has no data-plane binding by default.  A backend may only
 * be enabled through an explicit, HTTPS staging origin injected at runtime.
 * There is deliberately no committed fallback target.
 */
export function getStagingBackendOrigin(): string | null {
  const runtime = globalThis as typeof globalThis & {
    __env__?: RuntimeEnvironment;
    process?: { env?: RuntimeEnvironment };
  };
  const configured = runtime.__env__?.STAGING_BACKEND_ORIGIN ?? runtime.process?.env?.STAGING_BACKEND_ORIGIN;
  if (!configured) return null;

  try {
    const url = new URL(configured);
    return url.protocol === "https:" && url.hostname.includes("staging") ? url.origin : null;
  } catch {
    return null;
  }
}

function isStagingOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname.includes("staging");
  } catch {
    return false;
  }
}

/**
 * Determines whether the current request is running on the Shared Backend site.
 */
export function isBackendSite(request: Request): boolean {
  const backendOrigin = getStagingBackendOrigin();
  if (!backendOrigin) return false;
  try {
    const url = new URL(request.url);
    return url.origin === backendOrigin;
  } catch {
    return false;
  }
}

/**
 * Determines whether the current request should be delegated/proxied to the shared backend.
 * Only delegates in production when running on a frontend domain (student or admin).
 */
export function shouldDelegateToBackend(request: Request): boolean {
  if (!isProductionEnvironment()) return false;
  const backendOrigin = getStagingBackendOrigin();
  if (!backendOrigin) return false;
  try {
    const url = new URL(request.url);
    if (url.origin === backendOrigin) {
      return false;
    }
    return isStagingOrigin(url.origin);
  } catch {
    return false;
  }
}

/**
 * Forward/proxy a request to the shared backend worker.
 */
export async function delegateToBackend(request: Request, path: string): Promise<Response> {
  const backendOrigin = getStagingBackendOrigin();
  if (!backendOrigin) {
    return Response.json(
      {
        error: "backend_disabled",
        message: "Staging backend delegation is disabled because no staging backend is configured.",
      },
      { status: 503, headers: { "x-data-plane": "disabled" } }
    );
  }
  const reqUrl = new URL(request.url);
  const backendTarget = new URL(path, backendOrigin);
  backendTarget.search = reqUrl.search;

  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (["host", "content-length", "cf-connecting-ip", "cf-ray"].includes(lowerKey)) continue;
    forwardHeaders.set(key, value);
  }

  forwardHeaders.set("x-forwarded-host", reqUrl.hostname);
  forwardHeaders.set("x-forwarded-proto", reqUrl.protocol.replace(":", ""));

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

    responseHeaders.set("x-data-plane", "staging-backend");

    const responseBody = await backendResponse.arrayBuffer();
    return new Response(responseBody, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return Response.json(
      {
        error: "backend_unavailable",
        message: "Configured staging backend service is unreachable",
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
    isStagingOrigin(origin) ||
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
