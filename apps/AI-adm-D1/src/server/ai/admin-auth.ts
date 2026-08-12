import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AdminSessionRepo } from "@ai-smartbook/db";
import { resolveAdminAllowedOrigins } from "./admin-origin";

export const ADMIN_SESSION_COOKIE = "ai_admin_session";
export const ADMIN_CSRF_COOKIE = "ai_admin_csrf";
export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type AdminAuthActor =
  | { kind: "session"; id: string; username: string }
  | { kind: "token"; id: "admin-api-token" };

declare global {
  namespace Express {
    interface Request {
      adminAuth?: AdminAuthActor;
    }
  }
}

export type AdminAuthConfig = {
  production: boolean;
  token: string | undefined;
  username: string | undefined;
  password: string | undefined;
  passwordHash: string | undefined;
  sessionTtlMs: number;
  sessionCookie: string;
  csrfCookie: string;
  secureCookies: boolean;
  /** Retained as a compatibility field; insecure development bypass is gone. */
  allowInsecureDev: false;
};

export function resolveAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  const production = env.NODE_ENV === "production";
  const configuredTtl = Number(env.ADMIN_SESSION_TTL_MS);
  return {
    production,
    token: env.ADMIN_API_TOKEN?.trim() || undefined,
    username: env.ADMIN_USERNAME?.trim() || undefined,
    password: env.ADMIN_PASSWORD || undefined,
    passwordHash: env.ADMIN_PASSWORD_HASH?.trim() || undefined,
    sessionTtlMs: Number.isFinite(configuredTtl) && configuredTtl > 0
      ? Math.floor(configuredTtl)
      : DEFAULT_ADMIN_SESSION_TTL_MS,
    sessionCookie: env.ADMIN_SESSION_COOKIE?.trim() || ADMIN_SESSION_COOKIE,
    csrfCookie: env.ADMIN_CSRF_COOKIE?.trim() || ADMIN_CSRF_COOKIE,
    secureCookies: env.ADMIN_SESSION_SECURE !== "false",
    allowInsecureDev: false
  };
}

/** Fail closed at the production process boundary before a listener opens. */
export function assertAdminAuthConfig(config: AdminAuthConfig): void {
  if (!config.production) return;
  if (!config.username || !config.passwordHash) {
    throw new Error("production admin auth requires ADMIN_USERNAME and ADMIN_PASSWORD_HASH");
  }
  if (!config.secureCookies) {
    throw new Error("production admin auth requires ADMIN_SESSION_SECURE=true");
  }
}

export function digestAdminSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    const raw = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export function readAdminCookie(req: Request, name: string): string | undefined {
  return readCookie(req, name);
}

function parsePasswordHash(encoded: string): { salt: Buffer; derived: Buffer; cost: number; blockSize: number; parallelization: number } | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (![cost, blockSize, parallelization].every((value) => Number.isInteger(value) && value > 0)) return undefined;
  try {
    const salt = Buffer.from(parts[4], "base64url");
    const derived = Buffer.from(parts[5], "base64url");
    if (salt.length < 16 || derived.length < 16) return undefined;
    return { salt, derived, cost, blockSize, parallelization };
  } catch {
    return undefined;
  }
}

/** Generate an env-safe password hash for deployment configuration. */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(16);
  const cost = 16_384;
  const blockSize = 8;
  const parallelization = 1;
  const derived = scryptSync(password, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 32 * 1024 * 1024
  });
  return ["scrypt", cost, blockSize, parallelization, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

function verifyPassword(password: string, config: AdminAuthConfig): boolean {
  if (config.passwordHash) {
    const parsed = parsePasswordHash(config.passwordHash);
    if (!parsed) return false;
    try {
      const derived = scryptSync(password, parsed.salt, parsed.derived.length, {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelization,
        maxmem: 32 * 1024 * 1024
      });
      return sameSecret(derived.toString("hex"), parsed.derived.toString("hex"));
    } catch {
      return false;
    }
  }
  // Plaintext configuration is intentionally a local-development fallback;
  // production requires ADMIN_PASSWORD_HASH so a deployment cannot silently
  // keep a plaintext password in its process environment.
  return !config.production && config.password !== undefined && sameSecret(password, config.password);
}

export function adminCredentialsMatch(
  username: string,
  password: string,
  config: AdminAuthConfig = resolveAdminAuthConfig()
): boolean {
  return Boolean(config.username && sameSecret(username, config.username) && verifyPassword(password, config));
}

export function createAdminSessionSecrets() {
  return {
    sessionToken: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url")
  };
}

function sessionCookieOptions(config: AdminAuthConfig) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge: config.sessionTtlMs
  };
}

function csrfCookieOptions(config: AdminAuthConfig) {
  return {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge: config.sessionTtlMs
  };
}

export function setAdminSessionCookies(res: Response, config: AdminAuthConfig, sessionToken: string, csrfToken: string): void {
  res.cookie(config.sessionCookie, sessionToken, sessionCookieOptions(config));
  res.cookie(config.csrfCookie, csrfToken, csrfCookieOptions(config));
}

export function clearAdminSessionCookies(res: Response, config: AdminAuthConfig): void {
  const { maxAge: _sessionMaxAge, ...sessionOptions } = sessionCookieOptions(config);
  const { maxAge: _csrfMaxAge, ...csrfOptions } = csrfCookieOptions(config);
  res.clearCookie(config.sessionCookie, sessionOptions);
  res.clearCookie(config.csrfCookie, { ...csrfOptions, httpOnly: false });
}

/** One boundary for every `/api/admin/*` route. */
export function createAdminAuthMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  sessionsOrWarn?: AdminSessionRepo | ((message: string) => void),
  _warn: (message: string) => void = console.warn
): RequestHandler {
  const config = resolveAdminAuthConfig(env);
  const sessions = typeof sessionsOrWarn === "function" ? undefined : sessionsOrWarn;

  return (req: Request, res: Response, next: NextFunction) => {
    const rawSession = readCookie(req, config.sessionCookie);
    if (rawSession && sessions) {
      const session = sessions.findActiveByTokenDigest(digestAdminSecret(rawSession));
      if (session) {
        req.adminAuth = { kind: "session", id: session.id, username: session.username };
        return next();
      }
    }

    const candidate = candidateToken(req);
    if (config.token && candidate && sameSecret(candidate, config.token)) {
      req.adminAuth = { kind: "token", id: "admin-api-token" };
      return next();
    }

    return res.status(401).json({ error: "admin authentication required" });
  };
}

function isUnsafeMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

/** CSRF applies to browser sessions; token/Bearer clients remain automation-safe. */
export function createAdminCsrfMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  sessions?: AdminSessionRepo
): RequestHandler {
  const config = resolveAdminAuthConfig(env);
  const allowedOrigins = resolveAdminAllowedOrigins(env);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isUnsafeMethod(req.method) || req.adminAuth?.kind !== "session") return next();

    const origin = req.header("origin");
    if (!origin || !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "admin origin is required" });
    }

    const headerToken = req.header("x-csrf-token")?.trim();
    const cookieToken = readCookie(req, config.csrfCookie);
    if (!headerToken || !cookieToken || !sameSecret(headerToken, cookieToken) || !sessions) {
      return res.status(403).json({ error: "csrf validation failed" });
    }
    if (!sessions.verifyCsrfToken(req.adminAuth.id, digestAdminSecret(headerToken))) {
      return res.status(403).json({ error: "csrf validation failed" });
    }
    return next();
  };
}
