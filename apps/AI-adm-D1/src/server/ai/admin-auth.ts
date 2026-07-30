import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export type AdminAuthConfig = {
  production: boolean;
  token: string | undefined;
  allowInsecureDev: boolean;
};

export function resolveAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  const production = env.NODE_ENV === "production";
  return {
    production,
    token: env.ADMIN_API_TOKEN?.trim() || undefined,
    allowInsecureDev: !production && env.ADMIN_ALLOW_INSECURE_DEV === "true"
  };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function candidateToken(req: Request): string | undefined {
  const header = req.header("x-admin-token")?.trim();
  if (header) return header;
  const authorization = req.header("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/** One boundary for every `/api/admin/*` route. */
export function createAdminAuthMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): RequestHandler {
  const config = resolveAdminAuthConfig(env);
  if (config.allowInsecureDev) {
    warn("[security] ADMIN_ALLOW_INSECURE_DEV=true: admin API auth is disabled for this non-production process");
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const candidate = candidateToken(req);
    if (config.token && candidate && sameSecret(candidate, config.token)) {
      return next();
    }
    if (!config.token && config.production) {
      return res.status(503).json({ error: "admin API authentication is not configured" });
    }
    if (!config.token && config.allowInsecureDev) return next();
    return res.status(401).json({ error: "admin authentication required" });
  };
}
