import { ADMIN_CSRF_COOKIE } from "./admin-auth-contract";

export type CredentialTestDetails = {
  reason: string;
  latencyMs: number;
  endpointProfile: string | null;
  upstreamRequestSent: boolean;
};

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly fields?: Record<string, string> | string[],
    public readonly details?: CredentialTestDetails
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

let unauthorizedHandler: (() => void) | undefined;

/** Install the single SPA-level 401 policy; pages should not duplicate it. */
export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

export function readCsrfCookie(): string {
  if (typeof document === "undefined") return "";
  const prefix = `${ADMIN_CSRF_COOKIE}=`;
  for (const item of document.cookie.split(";")) {
    const value = item.trim();
    if (!value.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      return value.slice(prefix.length);
    }
  }
  return "";
}

/** Shared browser request, response, CSRF and error boundary for Admin APIs. */
export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !path.startsWith("/api/admin/auth/login")) {
    const csrfToken = readCsrfCookie();
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      code?: string;
      fields?: Record<string, string> | string[];
      fieldErrors?: Record<string, string>;
      reason?: unknown;
      latencyMs?: unknown;
      endpointProfile?: unknown;
      upstreamRequestSent?: unknown;
    };
    const details: CredentialTestDetails | undefined =
      typeof data.reason === "string"
      && typeof data.latencyMs === "number"
      && (typeof data.endpointProfile === "string" || data.endpointProfile === null)
      && typeof data.upstreamRequestSent === "boolean"
        ? {
            reason: data.reason,
            latencyMs: data.latencyMs,
            endpointProfile: data.endpointProfile,
            upstreamRequestSent: data.upstreamRequestSent
          }
        : undefined;
    const error = new ApiHttpError(
      res.status,
      data.error || data.message || `${res.status} ${res.statusText}`,
      data.code,
      data.fieldErrors ?? data.fields,
      details
    );
    if (res.status === 401 && !path.startsWith("/api/admin/auth/login") && !path.startsWith("/api/admin/auth/me")) {
      unauthorizedHandler?.();
    }
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
