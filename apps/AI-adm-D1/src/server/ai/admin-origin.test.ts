import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { createAdminAuthMiddleware } from "./admin-auth";
import { createAdminOriginMiddleware, LOCAL_ADMIN_ORIGINS, resolveAdminAllowedOrigins } from "./admin-origin";

function request(method: string, origin?: string): Request {
  return {
    method,
    header(name: string) {
      if (name.toLowerCase() === "origin") return origin;
      return undefined;
    }
  } as Request;
}

function response() {
  let statusCode = 200;
  const headers = new Map<string, string>();
  let body: unknown;
  const result = {
    status(code: number) { statusCode = code; return result; },
    json(value: unknown) { body = value; return result; },
    sendStatus(code: number) { statusCode = code; return result; },
    setHeader(name: string, value: string) { headers.set(name, value); return result; }
  } as unknown as Response;
  return { result, get statusCode() { return statusCode; }, get body() { return body; }, headers };
}

function runChain(method: string, origin: string | undefined, token: string | undefined) {
  const req = request(method, origin);
  const res = response();
  let passedOrigin = false;
  let passedAuth = false;
  const nextAuth: NextFunction = () => { passedAuth = true; };
  const authRequest = { ...req, header(name: string) {
    if (name.toLowerCase() === "origin") return origin;
    if (name.toLowerCase() === "x-admin-token") return token;
    return undefined;
  } } as Request;
  createAdminOriginMiddleware({ NODE_ENV: "development", ADMIN_ALLOWED_ORIGINS: LOCAL_ADMIN_ORIGINS.join(",") })(req, res.result, () => {
    passedOrigin = true;
    createAdminAuthMiddleware({ NODE_ENV: "development", ADMIN_DEV_PASSWORD: "valid-token" })(authRequest, res.result, nextAuth);
  });
  return { ...res, passedOrigin, passedAuth };
}

describe("Admin origin and auth boundary", () => {
  it("allows configured local origin with a valid proxy token for GET and POST", () => {
    for (const method of ["GET", "POST"]) {
      const result = runChain(method, "http://127.0.0.1:5174", "valid-token");
      expect(result.passedOrigin).toBe(true);
      expect(result.passedAuth).toBe(true);
      expect(result.statusCode).toBe(200);
    }
  });

  it("rejects an invalid origin with 403 before authentication", () => {
    const result = runChain("POST", "https://evil.example", "valid-token");
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "admin origin is not allowed" });
    expect(result.passedAuth).toBe(false);
  });

  it("returns 401 for an allowed origin with a missing token", () => {
    const result = runChain("POST", "http://localhost:5174", undefined);
    expect(result.passedOrigin).toBe(true);
    expect(result.statusCode).toBe(401);
    expect(result.passedAuth).toBe(false);
  });

  it("uses only the two local defaults and fails closed for production without explicit origins", () => {
    expect([...resolveAdminAllowedOrigins({ NODE_ENV: "development" })]).toEqual([...LOCAL_ADMIN_ORIGINS]);
    expect(resolveAdminAllowedOrigins({ NODE_ENV: "production" }).size).toBe(0);
  });
});
