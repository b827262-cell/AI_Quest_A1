import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_CSRF_COOKIE,
  adminCredentialsMatch,
  assertAdminAuthConfig,
  createAdminAuthMiddleware,
  createAdminCsrfMiddleware,
  createAdminLoginThrottle,
  hashAdminPassword,
  resolveAdminAuthConfig,
  setAdminSessionCookies,
  clearAdminSessionCookies
} from "./admin-auth";

function invoke(env: NodeJS.ProcessEnv, headers: Record<string, string> = {}) {
  let nextCalled = false;
  let statusCode = 200;
  let body: unknown;
  const req = {
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as never;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    }
  } as never;
  createAdminAuthMiddleware(env, () => {})(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, body };
}

describe("admin auth boundary", () => {
  it("rejects production without a session or token with 401", () => {
    expect(invoke({ NODE_ENV: "production" }).statusCode).toBe(401);
  });

  it("rejects development without explicit insecure opt-in", () => {
    expect(invoke({ NODE_ENV: "development" }).statusCode).toBe(401);
  });

  it("ignores the insecure development flag", () => {
    expect(invoke({ NODE_ENV: "development", ADMIN_ALLOW_INSECURE_DEV: "true" }).nextCalled)
      .toBe(false);
  });

  it("does not bypass auth when the insecure flag and token are both configured", () => {
    const env = {
      NODE_ENV: "development",
      ADMIN_API_TOKEN: "admin-secret",
      ADMIN_ALLOW_INSECURE_DEV: "true"
    };
    expect(invoke(env).nextCalled).toBe(false);
  });

  it("accepts the correct bearer token and rejects the wrong one", () => {
    const env = { NODE_ENV: "production", ADMIN_API_TOKEN: "admin-secret" };
    expect(invoke(env, { authorization: "Bearer admin-secret" }).nextCalled).toBe(true);
    expect(invoke(env, { authorization: "Bearer wrong" }).statusCode).toBe(401);
  });

  it("never treats the insecure flag as production configuration", () => {
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_ALLOW_INSECURE_DEV: "true"
    });
    expect(config.allowInsecureDev).toBe(false);
  });

  it("requires a hashed password and secure cookies at the production boundary", async () => {
    const passwordHash = hashAdminPassword("production-secret");
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: passwordHash,
      ADMIN_SESSION_SECURE: "true"
    });
    expect(() => assertAdminAuthConfig(config)).not.toThrow();
    await expect(adminCredentialsMatch("admin", "production-secret", config)).resolves.toBe(true);
    await expect(adminCredentialsMatch("admin", "wrong", config)).resolves.toBe(false);
    await expect(adminCredentialsMatch("admin", "production-secret", resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "production-secret",
      ADMIN_SESSION_SECURE: "true"
    }))).resolves.toBe(false);
    expect(() => assertAdminAuthConfig(resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "production-secret",
      ADMIN_SESSION_SECURE: "true"
    }))).toThrow(/ADMIN_PASSWORD_HASH/);
    expect(() => assertAdminAuthConfig(resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: passwordHash,
      ADMIN_SESSION_SECURE: "false"
    }))).toThrow(/ADMIN_SESSION_SECURE/);
  });
});

describe("admin login async KDF and throttling", () => {
  it("AUTH-RL-1: verifies a valid scrypt password asynchronously", async () => {
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: hashAdminPassword("correct-password")
    });
    await expect(adminCredentialsMatch("admin", "correct-password", config)).resolves.toBe(true);
  });

  it("AUTH-RL-2: yields to the event loop while scrypt runs", async () => {
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: hashAdminPassword("correct-password")
    });
    let yielded = false;
    const verification = adminCredentialsMatch("admin", "correct-password", config);
    await new Promise<void>((resolve) => setImmediate(() => { yielded = true; resolve(); }));
    expect(yielded).toBe(true);
    await expect(verification).resolves.toBe(true);
  });

  it("AUTH-RL-3: rejects an invalid password without throwing", async () => {
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: hashAdminPassword("correct-password")
    });
    await expect(adminCredentialsMatch("admin", "wrong-password", config)).resolves.toBe(false);
  });

  it("AUTH-RL-4: reserves source capacity before work begins", () => {
    const throttle = createAdminLoginThrottle({ sourceLimit: 1, accountLimit: 10 });
    expect(throttle.reserve("192.0.2.1", "admin", 1).allowed).toBe(true);
    expect(throttle.reserve("192.0.2.1", "other", 1).allowed).toBe(false);
  });

  it("AUTH-RL-5: throttles an account across independent sources", () => {
    const throttle = createAdminLoginThrottle({ sourceLimit: 10, accountLimit: 1 });
    expect(throttle.reserve("192.0.2.1", "admin", 1).allowed).toBe(true);
    expect(throttle.reserve("192.0.2.2", "admin", 1).allowed).toBe(false);
  });

  it("AUTH-RL-6: normalizes account case and surrounding whitespace", () => {
    const throttle = createAdminLoginThrottle({ sourceLimit: 10, accountLimit: 1 });
    throttle.reserve("192.0.2.1", " Admin ", 1);
    expect(throttle.reserve("192.0.2.2", "admin", 1).allowed).toBe(false);
  });

  it("AUTH-RL-7: keeps distinct account buckets independent", () => {
    const throttle = createAdminLoginThrottle({ sourceLimit: 10, accountLimit: 1 });
    throttle.reserve("192.0.2.1", "admin-a", 1);
    expect(throttle.reserve("192.0.2.2", "admin-b", 1).allowed).toBe(true);
  });

  it("AUTH-RL-8: expires failed attempts after the window", () => {
    const throttle = createAdminLoginThrottle({ windowMs: 1_000, sourceLimit: 1, accountLimit: 1 });
    throttle.reserve("192.0.2.1", "admin", 1);
    expect(throttle.reserve("192.0.2.1", "admin", 1_001).allowed).toBe(true);
  });

  it("AUTH-RL-9: clears the account reservation after successful authentication", () => {
    const throttle = createAdminLoginThrottle({ sourceLimit: 10, accountLimit: 1 });
    throttle.reserve("192.0.2.1", "admin", 1).finish(true);
    expect(throttle.reserve("192.0.2.2", "admin", 2).allowed).toBe(true);
  });

  it("AUTH-RL-10: emits a retry delay and places the gate before the KDF call", () => {
    const throttle = createAdminLoginThrottle({ windowMs: 2_000, sourceLimit: 1, accountLimit: 10 });
    throttle.reserve("192.0.2.1", "admin", 1_000);
    expect(throttle.reserve("192.0.2.1", "other", 1_001)).toMatchObject({ allowed: false, retryAfterSeconds: 2 });
    const appSource = readFileSync(join(process.cwd(), "src/server/app.ts"), "utf8");
    expect(appSource.indexOf("adminLoginThrottle.reserve")).toBeLessThan(appSource.indexOf("await adminCredentialsMatch"));
    expect(appSource).toContain('res.setHeader("Retry-After"');
  });
});

describe("canonical CSRF cookie contract", () => {
  const config = resolveAdminAuthConfig({
    NODE_ENV: "test",
    ADMIN_CSRF_COOKIE: "custom_cookie",
    ADMIN_SESSION_SECURE: "true"
  });

  it("CSRF-CONTRACT-1: defines the single canonical cookie name", () => {
    expect(ADMIN_CSRF_COOKIE).toBe("ai_admin_csrf");
  });

  it("CSRF-CONTRACT-2: does not expose an environment-configurable CSRF field", () => {
    expect(config).not.toHaveProperty("csrfCookie");
  });

  it("CSRF-CONTRACT-3: always sets the canonical cookie", () => {
    const cookie = vi.fn();
    setAdminSessionCookies({ cookie } as never, config, "session", "csrf");
    expect(cookie).toHaveBeenCalledWith(ADMIN_CSRF_COOKIE, "csrf", expect.any(Object));
    expect(cookie).not.toHaveBeenCalledWith("custom_cookie", expect.anything(), expect.anything());
  });

  it("CSRF-CONTRACT-4: always clears the canonical cookie", () => {
    const clearCookie = vi.fn();
    clearAdminSessionCookies({ clearCookie } as never, config);
    expect(clearCookie).toHaveBeenCalledWith(ADMIN_CSRF_COOKIE, expect.any(Object));
    expect(clearCookie).not.toHaveBeenCalledWith("custom_cookie", expect.anything());
  });

  it("CSRF-CONTRACT-5: middleware rejects a custom cookie and accepts the canonical cookie", () => {
    const sessions = { verifyCsrfToken: vi.fn(() => true) } as never;
    const middleware = createAdminCsrfMiddleware({
      NODE_ENV: "test",
      ADMIN_CSRF_COOKIE: "custom_cookie",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example.com"
    }, sessions);
    function invokeCsrf(cookie: string) {
      const next = vi.fn();
      const status = vi.fn().mockReturnThis();
      const json = vi.fn().mockReturnThis();
      middleware({
        method: "POST",
        adminAuth: { kind: "session", id: "session-id", username: "admin" },
        header(name: string) {
          return ({ origin: "https://admin.example.com", "x-csrf-token": "token", cookie })[name.toLowerCase()];
        }
      } as never, { status, json } as never, next);
      return { next, status };
    }
    expect(invokeCsrf("custom_cookie=token").status).toHaveBeenCalledWith(403);
    expect(invokeCsrf(`${ADMIN_CSRF_COOKIE}=token`).next).toHaveBeenCalledOnce();
  });

  it("CSRF-CONTRACT-6: the SPA reads the shared canonical contract", () => {
    const apiSource = readFileSync(join(process.cwd(), "src/api.ts"), "utf8");
    expect(apiSource).toContain('import { ADMIN_CSRF_COOKIE } from "./admin-auth-contract"');
    expect(apiSource).toContain("`${ADMIN_CSRF_COOKIE}=`");
    expect(apiSource).not.toContain('const prefix = "ai_admin_csrf="');
  });
});
