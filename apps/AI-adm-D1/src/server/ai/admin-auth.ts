import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const DEFAULT_ADMIN_DEV_PASSWORD = "827827";

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
  } else if (!config.production && config.devPassword === DEFAULT_ADMIN_DEV_PASSWORD) {
    warn("[security] development admin password is using the local default; never use this mode in production");
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (config.allowInsecureDev) return next();

    const candidate = candidateToken(req);
    const acceptedSecret = config.production ? config.token : config.devPassword;
    if (acceptedSecret && candidate && sameSecret(candidate, acceptedSecret)) {
      return next();
    }

    if (!config.token && config.production) {
      return res.status(503).json({ error: "admin API authentication is not configured" });
    }
    return res.status(401).json({ error: "admin authentication required" });
  };
}
