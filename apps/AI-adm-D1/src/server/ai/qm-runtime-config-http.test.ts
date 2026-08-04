import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QmRuntimeConfigDeps } from "./qm-status-api";
import { registerQmAdminBoundary } from "./qm-admin-boundary";

/* ── Injectable service + probe doubles ────────────────────────
 * The route module depends on a service + probe factory; we inject stubs so the
 * HTTP boundary (401/403, exact blocked codes, masked-key-only body) is
 * exercised deterministically without a database or network. No real key,
 * secret, or token is ever constructed in this file. */

const service = vi.hoisted(() => ({
  resolve: vi.fn(),
  save: vi.fn(),
  getPublicView: vi.fn()
}));

vi.mock("./qm-runner", () => ({
  getCachedQmStatus: vi.fn(() => null),
  runValidate: vi.fn(),
  runSmoke: vi.fn(),
  redactSecrets: vi.fn((text: string) => text),
  buildQmChildEnv: vi.fn(),
  buildQmRunEnv: vi.fn()
}));

import { registerQmRuntimeConfigRoutes } from "./qm-status-api";

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  ADMIN_API_TOKEN: "admin-secret",
  ADMIN_ALLOWED_ORIGINS: "http://admin.test"
};

const PLAINTEXT_LEAK_PATTERNS = [
  /sk-[a-zA-Z0-9]/,
  /decrypted/,
  /plaintext/i
];

function assertNoPlaintextKey(body: unknown): void {
  const text = JSON.stringify(body);
  for (const pattern of PLAINTEXT_LEAK_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Response body leaked a key-shaped value: ${pattern} matched in ${text}`);
    }
  }
}

function makeDeps(): QmRuntimeConfigDeps {
  return {
    service: {
      resolve: service.resolve,
      save: service.save,
      getPublicView: service.getPublicView
    },
    buildProbe: () => async () => ({ upstreamRequestSent: true })
  };
}

async function startApp(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerQmAdminBoundary(app, ENV, makeDeps());
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

async function authed(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Origin: "http://admin.test",
      "x-admin-token": "admin-secret",
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

describe("QM runtime-config HTTP boundary", () => {
  let server: Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    service.resolve.mockReturnValue({ ok: true, config: { providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null }, effectiveBaseUrl: "https://api.example.com", credentialInCooldown: false });
    service.getPublicView.mockReturnValue({
      config: { providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null },
      providerDisplayName: "Anthropic", providerSlug: "anthropic", providerEnabled: true,
      credentialName: "prod", maskedApiKey: "ant****AB12", credentialStatus: "active",
      credentialInCooldown: false, effectiveBaseUrl: "https://api.example.com", updatedAt: null
    });
    service.save.mockImplementation((config: unknown) => config);
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
  });

  it("requires admin auth (401 without token, 403 bad origin)", async () => {
    const started = await startApp();
    server = started.server;

    const unauthenticated = await fetch(`${started.baseUrl}/api/admin/qm/runtime-config`, {
      headers: { Origin: "http://admin.test" }
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${started.baseUrl}/api/admin/qm/runtime-config`, {
      headers: { Origin: "http://evil.test", "x-admin-token": "admin-secret" }
    });
    expect(forbidden.status).toBe(403);
  });

  it("GET returns the masked-key public view and never a plaintext key", async () => {
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.maskedApiKey).toBe("ant****AB12");
    assertNoPlaintextKey(body);
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });

  it("PUT validates-then-saves and returns the saved config + resolution", async () => {
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config", {
      method: "PUT",
      body: JSON.stringify({ providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.credentialId).toBe("c");
    expect(service.save).toHaveBeenCalledOnce();
    assertNoPlaintextKey(body);
  });

  it("PUT returns 400 for an invalid config body", async () => {
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config", {
      method: "PUT",
      body: JSON.stringify({ providerConfigId: "" })
    });
    expect(res.status).toBe(400);
  });

  it("PUT surfaces the exact blocked code when resolve fails after save", async () => {
    service.resolve.mockReturnValue({ ok: false, reason: "QM_CREDENTIAL_DISABLED" });
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config", {
      method: "PUT",
      body: JSON.stringify({ providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("QM_CREDENTIAL_DISABLED");
    assertNoPlaintextKey(body);
  });

  it("POST test resolves first and fails closed with the exact code when blocked", async () => {
    service.resolve.mockReturnValue({ ok: false, reason: "QM_PROVIDER_DISABLED" });
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config/test", { method: "POST" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("QM_PROVIDER_DISABLED");
    assertNoPlaintextKey(body);
  });

  it("POST test runs the probe and returns a safe success result when resolved ok", async () => {
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config/test", { method: "POST" });
    expect([200, 502]).toContain(res.status);
    const body = await res.json();
    expect(body.model).toBe("m");
    assertNoPlaintextKey(body);
  });

  it("GET maps NOT_FOUND resolution to the public view (resolution carries the code)", async () => {
    service.resolve.mockReturnValue({ ok: false, reason: "QM_RUNTIME_CONFIG_NOT_FOUND" });
    const started = await startApp();
    server = started.server;
    const res = await authed(started.baseUrl, "/api/admin/qm/runtime-config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolution.reason).toBe("QM_RUNTIME_CONFIG_NOT_FOUND");
    assertNoPlaintextKey(body);
  });
});

describe("registerQmRuntimeConfigRoutes (direct, no boundary)", () => {
  it("registers all three runtime-config paths", () => {
    const paths = { get: [] as string[], post: [] as string[], put: [] as string[] };
    const app = {
      get: (p: string) => { paths.get.push(p); },
      post: (p: string) => { paths.post.push(p); },
      put: (p: string) => { paths.put.push(p); }
    } as unknown as express.Express;
    registerQmRuntimeConfigRoutes(app, makeDeps());
    expect(paths.get).toContain("/api/admin/qm/runtime-config");
    expect(paths.put).toContain("/api/admin/qm/runtime-config");
    expect(paths.post).toContain("/api/admin/qm/runtime-config/test");
  });
});
