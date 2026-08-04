import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQmNotCheckedStatus } from "@ai-smartbook/contracts";

const runner = vi.hoisted(() => ({
  getCachedQmStatus: vi.fn(),
  runValidate: vi.fn(),
  runSmoke: vi.fn()
}));

vi.mock("./qm-runner", () => runner);

import { registerQmAdminBoundary } from "./qm-admin-boundary";

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  ADMIN_API_TOKEN: "admin-secret",
  ADMIN_ALLOWED_ORIGINS: "http://admin.test"
};

async function startApp(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerQmAdminBoundary(app, ENV);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Origin: "http://admin.test",
      "x-admin-token": "admin-secret",
      ...(init.headers ?? {})
    }
  });
}

describe("QM admin API HTTP boundary", () => {
  let server: Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    runner.getCachedQmStatus.mockReturnValue(makeQmNotCheckedStatus());
    runner.runValidate.mockResolvedValue(makeQmNotCheckedStatus());
    runner.runSmoke.mockResolvedValue(makeQmNotCheckedStatus());
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it("returns 401 for missing auth and 403 for a disallowed origin", async () => {
    const started = await startApp();
    server = started.server;

    const unauthenticated = await fetch(`${started.baseUrl}/api/admin/qm/status`, {
      headers: { Origin: "http://admin.test" }
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${started.baseUrl}/api/admin/qm/status`, {
      headers: { Origin: "http://evil.test", "x-admin-token": "admin-secret" }
    });
    expect(forbidden.status).toBe(403);
  });

  it("serves the formal not_checked response and GET does not run the CLI", async () => {
    const started = await startApp();
    server = started.server;

    const response = await request(started.baseUrl, "/api/admin/qm/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "not_checked", contract: null, doctor: null });
    expect(runner.runValidate).not.toHaveBeenCalled();
    expect(runner.runSmoke).not.toHaveBeenCalled();
  });

  it("maps a concurrent operation to 409 over a real HTTP round-trip", async () => {
    runner.runSmoke.mockRejectedValue(new Error("operation_already_running: validate"));
    const started = await startApp();
    server = started.server;

    const response = await request(started.baseUrl, "/api/admin/qm/smoke", { method: "POST" });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("QM_OPERATION_IN_PROGRESS");
  });

  it("returns a fixed safe 500 body without internal failure details", async () => {
    runner.runValidate.mockRejectedValue(new Error("/home/runner/project SECRET_VALUE=do-not-leak\nError: stack"));
    const started = await startApp();
    server = started.server;

    const response = await request(started.baseUrl, "/api/admin/qm/validate", { method: "POST" });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("QM validation failed");
    expect(body).not.toContain("/home/runner/project");
    expect(body).not.toContain("do-not-leak");
    expect(body).not.toContain("stack");
  });
});
