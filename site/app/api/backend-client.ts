import { isProductionEnvironment } from "../../db/index.ts";

type BackendRuntime = typeof globalThis & { STAGING_BACKEND_ORIGIN?: string };

/**
 * A backend may only be enabled by an explicitly injected staging origin.  There
 * is intentionally no fallback: absent configuration must not cause an outbound
 * request to a production service.
 */
function getStagingBackendOrigin(): string | null {
  const configuredOrigin = (globalThis as BackendRuntime).STAGING_BACKEND_ORIGIN;
  if (!configuredOrigin) return null;

  try {
    const origin = new URL(configuredOrigin);
    return origin.protocol === "https:" && origin.origin === configuredOrigin.replace(/\/$/, "")
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

export const SHARED_BACKEND_ORIGIN = getStagingBackendOrigin();

export const ALLOWED_CORS_ORIGINS = [
  "https://ai-quest-a1-student.b827262.chatgpt.site",
  "https://ai-quest-a1-admin.b827262.chatgpt.site",
];

/**
 * Determines whether the current request is running on the Shared Backend site.
 */
export function isBackendSite(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.hostname.includes("ai-quest-a1-backend");
  } catch {
    return false;
  }
}

/**
 * Determines whether the current request should be delegated/proxied to the shared backend.
 * Only delegates in production when running on a frontend domain (student or admin).
 */
export function shouldDelegateToBackend(request: Request): boolean {
  if (!SHARED_BACKEND_ORIGIN) return false;
  if (!isProductionEnvironment()) return false;
  try {
    const url = new URL(request.url);
    if (url.hostname.includes("ai-quest-a1-backend")) {
      return false;
    }
    if (
      url.hostname.includes("ai-quest-a1-student") ||
      url.hostname.includes("ai-quest-a1-admin") ||
      (url.hostname.endsWith(".chatgpt.site") && !url.hostname.includes("ai-quest-a1-backend"))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Forward/proxy a request to the shared backend worker.
 */
export async function delegateToBackend(request: Request, path: string): Promise<Response> {
  if (!SHARED_BACKEND_ORIGIN) {
    return Response.json(
      {
        error: "backend_disabled",
        message: "No staging backend origin is configured",
      },
      { status: 503 }
    );
  }

  const reqUrl = new URL(request.url);
  const backendTarget = new URL(path, SHARED_BACKEND_ORIGIN);
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

    responseHeaders.set("x-data-plane", "shared-backend");

    const responseBody = await backendResponse.arrayBuffer();
    return new Response(responseBody, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return Response.json(
      {
        error: "backend_unavailable",
        message: "Shared Backend service is unreachable",
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
