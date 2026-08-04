import { describe, it, expect, vi } from "vitest";
import { registerQmStatusRoutes } from "./qm-status-api";
import { createAdminAuthMiddleware } from "./admin-auth";

vi.mock("./qm-runner", () => ({
  getCachedQmStatus: vi.fn(() => null),
  runValidate: vi.fn(() => Promise.resolve({ overallStatus: "pass" })),
  runSmoke: vi.fn(() => Promise.reject(new Error("operation_already_running: smoke")))
}));

describe("qm-status-api", () => {
  it("blocks unauthenticated requests", () => {
    let statusCode = 200;
    const req = { header: () => undefined } as any;
    const res = { status: (c: number) => { statusCode = c; return res; }, json: () => {} } as any;
    const mw = createAdminAuthMiddleware({ NODE_ENV: "production", ADMIN_API_TOKEN: "admin-secret" } as any, () => {});
    mw(req, res, () => { statusCode = 404; });
    expect(statusCode).toBe(401);
  });

  it("GET /status returns null-like response when no cached data", () => {
    let handler: any;
    const mockApp = {
      get: (path: string, fn: any) => { if (path === "/api/admin/qm/status") handler = fn; },
      post: () => {}
    } as any;
    registerQmStatusRoutes(mockApp);
    
    const req = {} as any;
    let body: any;
    const res = { json: (v: any) => { body = v; return res; } } as any;
    
    handler(req, res);
    expect(body.overallStatus).toBe("warning");
  });

  it("POST /validate handles successful validation", async () => {
    let handler: any;
    const mockApp = {
      get: () => {},
      post: (path: string, fn: any) => { if (path === "/api/admin/qm/validate") handler = fn; }
    } as any;
    registerQmStatusRoutes(mockApp);
    
    const req = {} as any;
    let body: any;
    const res = { json: (v: any) => { body = v; return res; } } as any;
    
    await handler(req, res);
    expect(body.overallStatus).toBe("pass");
  });

  it("POST /smoke handles concurrent operation error gracefully", async () => {
    let handler: any;
    const mockApp = {
      get: () => {},
      post: (path: string, fn: any) => { if (path === "/api/admin/qm/smoke") handler = fn; }
    } as any;
    registerQmStatusRoutes(mockApp);
    
    const req = {} as any;
    let statusCode = 200;
    let body: any;
    const res = { 
      status: (c: number) => { statusCode = c; return res; },
      json: (v: any) => { body = v; return res; }
    } as any;
    
    await handler(req, res);
    expect(statusCode).toBe(409);
    expect(body.error).toContain("in progress");
  });
});
