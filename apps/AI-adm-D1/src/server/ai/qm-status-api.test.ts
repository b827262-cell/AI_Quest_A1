import { describe, it, expect, vi } from "vitest";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { registerQmStatusRoutes } from "./qm-status-api";

vi.mock("./qm-runner", () => ({
  getCachedQmStatus: vi.fn(() => null),
  runValidate: vi.fn(() => Promise.resolve({ overallStatus: "pass" })),
  runSmoke: vi.fn(() => Promise.reject(new Error("operation_already_running: smoke")))
}));

/* ── Minimal typed Express test harness ───────────────────────
 * `registerQmStatusRoutes` only calls `app.get`/`app.post`; a full `Express`
 * mock is unnecessary. The unauthenticated/forbidden-origin and safe-500
 * paths are already covered end-to-end over real HTTP in
 * qm-status-http.test.ts, so this file only needs to exercise the route
 * bodies registered here directly. */

function createMockApp(): { app: Express; routes: { get: Map<string, RequestHandler>; post: Map<string, RequestHandler> } } {
  const routes = { get: new Map<string, RequestHandler>(), post: new Map<string, RequestHandler>() };
  const registrar = {
    get(path: string, handler: RequestHandler) {
      routes.get.set(path, handler);
    },
    post(path: string, handler: RequestHandler) {
      routes.post.set(path, handler);
    }
  };
  return { app: registrar as unknown as Express, routes };
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) throw new Error(message);
}

function createRequest(): Request {
  return {} as unknown as Request;
}

const noopNext: NextFunction = () => {};

function createResponse(): { res: Response; readStatus: () => number; readBody: () => unknown } {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    }
  } as unknown as Response;
  return { res, readStatus: () => statusCode, readBody: () => body };
}

function hasStringField(value: unknown, field: string): value is Record<string, string> {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[field] === "string";
}

describe("qm-status-api", () => {
  it("GET /status returns the not-checked fallback when no cached data exists", () => {
    const { app, routes } = createMockApp();
    registerQmStatusRoutes(app);
    const handler = routes.get.get("/api/admin/qm/status");
    assertDefined(handler, "GET /api/admin/qm/status was not registered");

    const { res, readBody } = createResponse();
    handler(createRequest(), res, noopNext);

    const body = readBody();
    expect(hasStringField(body, "overallStatus")).toBe(true);
    if (hasStringField(body, "overallStatus")) {
      expect(body.overallStatus).toBe("warning");
    }
  });

  it("POST /validate returns the validation result on success", async () => {
    const { app, routes } = createMockApp();
    registerQmStatusRoutes(app);
    const handler = routes.post.get("/api/admin/qm/validate");
    assertDefined(handler, "POST /api/admin/qm/validate was not registered");

    const { res, readBody } = createResponse();
    await handler(createRequest(), res, noopNext);

    const body = readBody();
    expect(hasStringField(body, "overallStatus")).toBe(true);
    if (hasStringField(body, "overallStatus")) {
      expect(body.overallStatus).toBe("pass");
    }
  });

  it("POST /smoke handles a concurrent operation error gracefully", async () => {
    const { app, routes } = createMockApp();
    registerQmStatusRoutes(app);
    const handler = routes.post.get("/api/admin/qm/smoke");
    assertDefined(handler, "POST /api/admin/qm/smoke was not registered");

    const { res, readStatus, readBody } = createResponse();
    await handler(createRequest(), res, noopNext);

    expect(readStatus()).toBe(409);
    const body = readBody();
    expect(hasStringField(body, "error")).toBe(true);
    if (hasStringField(body, "error")) {
      expect(body.error).toContain("in progress");
    }
  });
});
