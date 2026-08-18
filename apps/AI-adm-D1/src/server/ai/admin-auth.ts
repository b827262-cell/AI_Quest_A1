import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AdminSessionRepo } from "@ai-smartbook/db";
import { ADMIN_CSRF_COOKIE } from "../../admin-auth-contract";
import { resolveAdminAllowedOrigins } from "./admin-origin";

export const ADMIN_SESSION_COOKIE = "ai_admin_session";
export { ADMIN_CSRF_COOKIE } from "../../admin-auth-contract";
export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const ADMIN_LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_LOGIN_SOURCE_LIMIT = 20;
export const ADMIN_LOGIN_ACCOUNT_LIMIT = 5;

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
  sessionCookieDomain: string | undefined;
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
    sessionCookieDomain: env.ADMIN_SESSION_COOKIE_DOMAIN?.trim() || undefined,
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

function deriveScryptKey(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function verifyPassword(password: string, config: AdminAuthConfig): Promise<boolean> {
  if (config.passwordHash) {
    const parsed = parsePasswordHash(config.passwordHash);
    if (!parsed) return false;
    try {
      const derived = await deriveScryptKey(password, parsed.salt, parsed.derived.length, {
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

export async function adminCredentialsMatch(
  username: string,
  password: string,
  config: AdminAuthConfig = resolveAdminAuthConfig()
): Promise<boolean> {
  const usernameMatches = Boolean(config.username && sameSecret(username, config.username));
  const passwordMatches = await verifyPassword(password, config);
  return usernameMatches && passwordMatches;
}

type LoginAttempt = { id: number; attemptedAt: number };

export type AdminLoginThrottleReservation = {
  allowed: boolean;
  retryAfterSeconds: number;
  finish(success: boolean): void;
};

export type AdminLoginThrottle = {
  reserve(source: string, account: string, now?: number): AdminLoginThrottleReservation;
};

/**
 * Reserves source and account capacity before password verification begins.
 * Failed reservations remain in their buckets; successful authentication
 * releases only its own reservation from both buckets.
 */
export function createAdminLoginThrottle(options: {
  windowMs?: number;
  sourceLimit?: number;
  accountLimit?: number;
} = {}): AdminLoginThrottle {
  const windowMs = options.windowMs ?? ADMIN_LOGIN_THROTTLE_WINDOW_MS;
  const sourceLimit = options.sourceLimit ?? ADMIN_LOGIN_SOURCE_LIMIT;
  const accountLimit = options.accountLimit ?? ADMIN_LOGIN_ACCOUNT_LIMIT;
  const sourceAttempts = new Map<string, LoginAttempt[]>();
  const accountAttempts = new Map<string, LoginAttempt[]>();
  let nextAttemptId = 1;

  function activeAttempts(store: Map<string, LoginAttempt[]>, key: string, now: number): LoginAttempt[] {
    const active = (store.get(key) ?? []).filter((attempt) => now - attempt.attemptedAt < windowMs);
    if (active.length > 0) store.set(key, active);
    else store.delete(key);
    return active;
  }

  function retryAt(attempts: LoginAttempt[], limit: number): number {
    return attempts.length >= limit ? attempts[attempts.length - limit]!.attemptedAt + windowMs : 0;
  }

  return {
    reserve(source, account, now = Date.now()) {
      const sourceKey = source || "unknown";
      const accountKey = digestAdminSecret(account.trim().toLowerCase());
      const activeSource = activeAttempts(sourceAttempts, sourceKey, now);
      const activeAccount = activeAttempts(accountAttempts, accountKey, now);
      const sourceRetryAt = retryAt(activeSource, sourceLimit);
      const accountRetryAt = retryAt(activeAccount, accountLimit);
      const blockedUntil = Math.max(sourceRetryAt, accountRetryAt);
      if (blockedUntil > now) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
          finish() {}
        };
      }

      const attempt: LoginAttempt = { id: nextAttemptId++, attemptedAt: now };
      activeSource.push(attempt);
      activeAccount.push(attempt);
      sourceAttempts.set(sourceKey, activeSource);
      accountAttempts.set(accountKey, activeAccount);
      let finished = false;
      return {
        allowed: true,
        retryAfterSeconds: 0,
        finish(success) {
          if (finished) return;
          finished = true;
          if (!success) return;
          const currentSource = sourceAttempts.get(sourceKey) ?? [];
          const withoutSuccess = currentSource.filter((entry) => entry.id !== attempt.id);
          if (withoutSuccess.length > 0) sourceAttempts.set(sourceKey, withoutSuccess);
          else sourceAttempts.delete(sourceKey);
          const currentAccount = accountAttempts.get(accountKey) ?? [];
          const accountWithoutSuccess = currentAccount.filter((entry) => entry.id !== attempt.id);
          if (accountWithoutSuccess.length > 0) accountAttempts.set(accountKey, accountWithoutSuccess);
          else accountAttempts.delete(accountKey);
        }
      };
    }
  };
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
    maxAge: config.sessionTtlMs,
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {})
  };
}

function csrfCookieOptions(config: AdminAuthConfig) {
  return {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    maxAge: config.sessionTtlMs,
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {})
  };
}

export function setAdminSessionCookies(res: Response, config: AdminAuthConfig, sessionToken: string, csrfToken: string): void {
  res.cookie(config.sessionCookie, sessionToken, sessionCookieOptions(config));
  res.cookie(ADMIN_CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
}

export function clearAdminSessionCookies(res: Response, config: AdminAuthConfig): void {
  const { maxAge: _sessionMaxAge, ...sessionOptions } = sessionCookieOptions(config);
  const { maxAge: _csrfMaxAge, ...csrfOptions } = csrfCookieOptions(config);
  res.clearCookie(config.sessionCookie, sessionOptions);
  res.clearCookie(ADMIN_CSRF_COOKIE, { ...csrfOptions, httpOnly: false });
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
  const allowedOrigins = resolveAdminAllowedOrigins(env);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isUnsafeMethod(req.method) || req.adminAuth?.kind !== "session") return next();

    const origin = req.header("origin");
    if (!origin || !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "admin origin is required" });
    }

    const headerToken = req.header("x-csrf-token")?.trim();
    const cookieToken = readCookie(req, ADMIN_CSRF_COOKIE);
    if (!headerToken || !cookieToken || !sameSecret(headerToken, cookieToken) || !sessions) {
      return res.status(403).json({ error: "csrf validation failed" });
    }
    if (!sessions.verifyCsrfToken(req.adminAuth.id, digestAdminSecret(headerToken))) {
      return res.status(403).json({ error: "csrf validation failed" });
    }
    return next();
  };
}
