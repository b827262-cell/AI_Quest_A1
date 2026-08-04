import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const DEFAULT_ADMIN_DEV_PASSWORD = "827827";

/**
 * Marks a 401 as a genuine admin-authentication failure (bad/missing token),
 * as opposed to a business-logic 401 elsewhere. The browser fetch
 * interceptor (`apps/AI-adm-D1/src/adminAuth.tsx`) only clears the session on
 * a 401 carrying this exact code and/or header — keep both copies of these
 * two literals in sync if either changes.
 */
export const ADMIN_AUTH_REQUIRED_CODE = "ADMIN_AUTH_REQUIRED";
export const ADMIN_AUTH_STATE_HEADER = "X-Admin-Auth-State";

export type AdminAuthConfig = {
  production: boolean;
  token: string | undefined;
  devPassword: string | undefined;
  allowInsecureDev: boolean;
};

export function resolveAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  const production = env.NODE_ENV === "production";
  return {
    production,
    token: env.ADMIN_API_TOKEN?.trim() || undefined,
    devPassword: production
      ? undefined
      : env.ADMIN_DEV_PASSWORD?.trim() || DEFAULT_ADMIN_DEV_PASSWORD,
    allowInsecureDev: !production && env.ADMIN_ALLOW_INSECURE_DEV === "true"
  };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function candidateAdminToken(req: Request): string | undefined {
  const header = req.header("x-admin-token")?.trim();
  if (header) return header;
  const authorization = req.header("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/**
 * The one canonical accepted-secret check: production compares against
 * `ADMIN_API_TOKEN`, non-production compares against the dev password. Every
 * admin auth guard (the shared `/api/admin` middleware below, and any
 * route-local defence-in-depth guard) must call this instead of
 * re-implementing its own comparison, so a valid dev-password login is never
 * accepted by one guard and rejected by another.
 */
export function isAcceptedAdminToken(candidate: string | undefined, config: AdminAuthConfig): boolean {
  const acceptedSecret = config.production ? config.token : config.devPassword;
  return Boolean(acceptedSecret && candidate && sameSecret(candidate, acceptedSecret));
}

/**
 * Send the exact, safe "admin auth required" response. Only ever call this
 * for a genuine authentication failure (bad/missing token) — never for a
 * business-logic 401 — since the browser interceptor treats this exact
 * shape as its sole signal to clear the session.
 */
export function sendAdminAuthRequired(res: Response): void {
  res.setHeader(ADMIN_AUTH_STATE_HEADER, "invalid");
  res.status(401).json({ error: "admin authentication required", code: ADMIN_AUTH_REQUIRED_CODE });
}

/** One boundary for every `/api/admin/*` route. */
export function createAdminAuthMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): RequestHandler {
  const config = resolveAdminAuthConfig(env);
  if (config.allowInsecureDev) {
    warn("[security] ADMIN_ALLOW_INSECURE_DEV=true: admin API auth is disabled for this non-production process");
  } else if (!config.production && config.devPassword === DEFAULT_ADMIN_DEV_PASSWORD) {
    warn("[security] development admin password is using the local default; never use this mode in production");
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (config.allowInsecureDev) return next();

    const candidate = candidateAdminToken(req);
    if (isAcceptedAdminToken(candidate, config)) {
      return next();
    }

    if (!config.token && config.production) {
      return res.status(503).json({ error: "admin API authentication is not configured" });
    }
    return sendAdminAuthRequired(res);
  };
}
