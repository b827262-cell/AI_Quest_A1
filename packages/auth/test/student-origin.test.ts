import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { createStudentOriginMiddleware } from "../src/express";
import { resolveStudentAuthConfig } from "../src/server";

function run(method: string, origin: string | undefined) {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown;
  let passed = false;
  const req = {
    method,
    header(name: string) {
      return name.toLowerCase() === "origin" ? origin : undefined;
    }
  } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(value: unknown) { body = value; return res; },
    sendStatus(code: number) { statusCode = code; return res; },
    setHeader(name: string, value: string) { headers.set(name, value); return res; }
  } as unknown as Response;
  const next: NextFunction = () => { passed = true; };
  createStudentOriginMiddleware(resolveStudentAuthConfig({
    NODE_ENV: "production",
    STUDENT_ALLOWED_ORIGINS: "https://student.example.com"
  }))(req, res, next);
  return { headers, statusCode, body, passed };
}

describe("Student API origin boundary", () => {
  it("reflects the exact configured origin and supports credentialed preflight", () => {
    const result = run("OPTIONS", "https://student.example.com");
    expect(result.statusCode).toBe(204);
    expect(result.passed).toBe(false);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("https://student.example.com");
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(result.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("rejects an unconfigured origin before reaching the API", () => {
    const result = run("GET", "https://evil.example");
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "student origin is not allowed" });
    expect(result.passed).toBe(false);
  });
});
