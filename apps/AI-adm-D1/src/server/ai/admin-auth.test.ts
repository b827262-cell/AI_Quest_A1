import { describe, expect, it } from "vitest";
import {
  adminCredentialsMatch,
  assertAdminAuthConfig,
  createAdminAuthMiddleware,
  hashAdminPassword,
  resolveAdminAuthConfig
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

  it("requires a hashed password and secure cookies at the production boundary", () => {
    const passwordHash = hashAdminPassword("production-secret");
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: passwordHash,
      ADMIN_SESSION_SECURE: "true"
    });
    expect(() => assertAdminAuthConfig(config)).not.toThrow();
    expect(adminCredentialsMatch("admin", "production-secret", config)).toBe(true);
    expect(adminCredentialsMatch("admin", "wrong", config)).toBe(false);
    expect(adminCredentialsMatch("admin", "production-secret", resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "production-secret",
      ADMIN_SESSION_SECURE: "true"
    }))).toBe(false);
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
