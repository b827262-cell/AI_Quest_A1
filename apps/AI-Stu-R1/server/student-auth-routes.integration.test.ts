import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudentAuthRuntime,
  resolveStudentAuthConfig
} from "@ai-smartbook/auth/server";
import { createStudentAuthRouter, createStudentSessionMiddleware } from "@ai-smartbook/auth/express";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeResponse {
  statusCode = 200;
  body: unknown;
  headers: Record<string, string | string[]> = {};
  private finishCallback: (() => void) | undefined;

  onFinish(callback: () => void): void {
    this.finishCallback = callback;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  append(name: string, value: string): this {
    const key = name.toLowerCase();
    const current = this.headers[key];
    this.headers[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.finishCallback?.();
    return this;
  }

  redirect(code: number, location: string): this {
    this.statusCode = code;
    this.setHeader("Location", location);
    this.finishCallback?.();
    return this;
  }

  end(): this {
    this.finishCallback?.();
    return this;
  }
}

function requestFor(path: string, method: string, query: Record<string, string> = {}, body: unknown = undefined, headers: Record<string, string> = {}): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    query,
    body,
    ip: "127.0.0.1",
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as unknown as Request;
}

async function dispatch(router: unknown, req: Request): Promise<FakeResponse> {
  const response = new FakeResponse();
  const routerWithHandle = router as { handle: (request: Request, response: Response, next: () => void) => void };
  await new Promise<void>((resolve) => {
    response.onFinish(resolve);
    routerWithHandle.handle(req, response as unknown as Response, resolve);
  });
  return response;
}

describe("Student Auth HTTP integration", () => {
  it("covers Google callback, state replay, profile gate, cookie boundary and logout revocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-quest-student-http-"));
    temporaryDirectories.push(directory);
    const config = resolveStudentAuthConfig({
      NODE_ENV: "test",
      STUDENT_GOOGLE_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "server-only-provider-secret",
      GOOGLE_REDIRECT_URI: "https://student.example.test/api/student/auth/google/callback",
      STUDENT_SESSION_SECRET: "a-test-session-secret-that-is-longer-than-32-chars",
      STUDENT_ALLOWED_ORIGINS: "https://student.example.test",
      GOOGLE_AUTHORIZATION_ENDPOINT: "https://accounts.example.test/oauth/authorize",
      GOOGLE_TOKEN_ENDPOINT: "https://accounts.example.test/oauth/token",
      GOOGLE_USERINFO_ENDPOINT: "https://accounts.example.test/oauth/userinfo",
      STUDENT_SESSION_TTL_MS: "3600000"
    });
    const runtime = createStudentAuthRuntime(join(directory, "auth.sqlite"), config);
    const router = createStudentAuthRouter(runtime.auth, config);
    const guard = createStudentSessionMiddleware(runtime.auth, config);

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === config.googleTokenEndpoint) return new Response(JSON.stringify({ access_token: "provider-access-token" }), { status: 200 });
      if (url === config.googleUserinfoEndpoint) return new Response(JSON.stringify({
        sub: "google-subject",
        email: "student@example.test",
        email_verified: true,
        name: "Student",
        picture: "https://example.test/avatar.png"
      }), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const start = await dispatch(router, requestFor("/google/start", "GET", { returnTo: "/books" }));
    expect(start.statusCode).toBe(302);
    const authorizationUrl = new URL(String(start.headers.location));
    const state = authorizationUrl.searchParams.get("state")!;
    const callback = await dispatch(router, requestFor("/google/callback", "GET", { state, code: "authorization-code" }));
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toContain("/profile-completion");
    const rawCookie = callback.headers["set-cookie"];
    const sessionCookie = Array.isArray(rawCookie) ? rawCookie[0].split(";", 1)[0] : String(rawCookie).split(";", 1)[0];
    expect(String(rawCookie)).toMatch(/HttpOnly/);
    expect(String(rawCookie)).toMatch(/Secure/);
    expect(String(rawCookie)).toMatch(/SameSite=strict/i);

    const me = await dispatch(router, requestFor("/me", "GET", {}, undefined, { cookie: sessionCookie }));
    expect(me.body).toMatchObject({ authenticated: true, user: { email: "student@example.test", profileCompleted: false } });

    const incompleteResponse = new FakeResponse();
    let incompleteNext = false;
    guard(requestFor("/protected", "GET", {}, undefined, { cookie: sessionCookie }), incompleteResponse as unknown as Response, () => { incompleteNext = true; });
    expect(incompleteResponse.statusCode).toBe(403);
    expect(incompleteNext).toBe(false);

    const completed = await dispatch(router, requestFor("/profile", "PATCH", {}, { displayName: "Student", schoolName: "Test University", gradeLevel: "Year 1" }, { cookie: sessionCookie, origin: "https://student.example.test" }));
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toMatchObject({ profile: { profileCompleted: true } });

    const allowedResponse = new FakeResponse();
    let allowedNext = false;
    guard(requestFor("/protected", "GET", {}, undefined, { cookie: sessionCookie }), allowedResponse as unknown as Response, () => { allowedNext = true; });
    expect(allowedNext).toBe(true);

    const replay = await dispatch(router, requestFor("/google/callback", "GET", { state, code: "authorization-code" }));
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toEqual({ error: "OAUTH_STATE_INVALID" });

    const logout = await dispatch(router, requestFor("/logout", "POST", {}, undefined, { cookie: sessionCookie, origin: "https://student.example.test" }));
    expect(logout.statusCode).toBe(204);
    const revokedResponse = new FakeResponse();
    let revokedNext = false;
    guard(requestFor("/protected", "GET", {}, undefined, { cookie: sessionCookie }), revokedResponse as unknown as Response, () => { revokedNext = true; });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedNext).toBe(false);
    runtime.dbHandle.sqlite.close();
  });
});
