import { describe, expect, it } from "vitest";
import { createAdminAuthMiddleware, resolveAdminAuthConfig } from "./admin-auth";

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
  it("rejects production without a token with 503", () => {
    expect(invoke({ NODE_ENV: "production" }).statusCode).toBe(503);
  });

  it("accepts the default development password", () => {
    expect(invoke(
      { NODE_ENV: "development" },
      { "x-admin-token": "827827" }
    ).nextCalled).toBe(true);
  });

  it("rejects an incorrect development password", () => {
    expect(invoke(
      { NODE_ENV: "development" },
      { "x-admin-token": "wrong" }
    ).statusCode).toBe(401);
  });

  it("allows overriding the development password", () => {
    const env = { NODE_ENV: "development", ADMIN_DEV_PASSWORD: "local-secret" };
    expect(invoke(env, { "x-admin-token": "local-secret" }).nextCalled).toBe(true);
    expect(invoke(env, { "x-admin-token": "827827" }).statusCode).toBe(401);
  });

  it("allows only explicit development insecure mode", () => {
    expect(invoke({ NODE_ENV: "development", ADMIN_ALLOW_INSECURE_DEV: "true" }).nextCalled)
      .toBe(true);
  });

  it("allows explicit insecure development mode even when a token is configured", () => {
    const env = {
      NODE_ENV: "development",
      ADMIN_API_TOKEN: "admin-secret",
      ADMIN_ALLOW_INSECURE_DEV: "true"
    };
    expect(invoke(env).nextCalled).toBe(true);
  });

  it("accepts the correct bearer token and rejects the wrong one in production", () => {
    const env = { NODE_ENV: "production", ADMIN_API_TOKEN: "admin-secret" };
    expect(invoke(env, { authorization: "Bearer admin-secret" }).nextCalled).toBe(true);
    expect(invoke(env, { authorization: "Bearer wrong" }).statusCode).toBe(401);
  });

  it("never exposes the development password in production configuration", () => {
    const config = resolveAdminAuthConfig({
      NODE_ENV: "production",
      ADMIN_DEV_PASSWORD: "827827",
      ADMIN_ALLOW_INSECURE_DEV: "true"
    });
    expect(config.devPassword).toBeUndefined();
    expect(config.allowInsecureDev).toBe(false);
  });
});
