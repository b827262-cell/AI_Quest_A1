import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError, http, setUnauthorizedHandler } from "./api-transport";

afterEach(() => {
  setUnauthorizedHandler(undefined);
  vi.unstubAllGlobals();
});

describe("Admin browser HTTP contract", () => {
  it("uses same-origin credentials and attaches CSRF to mutating requests", async () => {
    vi.stubGlobal("document", { cookie: "other=x; ai_admin_csrf=fixture%20csrf" });
    let request: { path: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      request = { path, init };
      return Response.json({ ok: true });
    });

    await expect(http<{ ok: boolean }>("/api/admin/books", {
      method: "POST", body: JSON.stringify({ title: "fixture" })
    })).resolves.toEqual({ ok: true });
    expect(request?.path).toBe("/api/admin/books");
    expect(request?.init.credentials).toBe("same-origin");
    expect(new Headers(request?.init.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request?.init.headers).get("X-CSRF-Token")).toBe("fixture csrf");
  });

  it("keeps login exempt from CSRF and returns undefined for 204", async () => {
    vi.stubGlobal("document", { cookie: "ai_admin_csrf=fixture" });
    let headers: Headers | undefined;
    vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response(null, { status: 204 });
    });
    await expect(http<void>("/api/admin/auth/login", { method: "POST", body: "{}" })).resolves.toBeUndefined();
    expect(headers?.has("X-CSRF-Token")).toBe(false);
  });

  it("preserves the one 401 callback policy and structured error details", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", async () => Response.json({
      error: "fixture denied", code: "denied", fieldErrors: { name: "invalid" },
      reason: "fixture reason", latencyMs: 12, endpointProfile: null, upstreamRequestSent: false
    }, { status: 401 }));

    for (const path of ["/api/admin/auth/login", "/api/admin/auth/me", "/api/admin/books"]) {
      await expect(http(path)).rejects.toMatchObject({
        status: 401, message: "fixture denied", code: "denied", fields: { name: "invalid" },
        details: { reason: "fixture reason", latencyMs: 12, endpointProfile: null, upstreamRequestSent: false }
      } satisfies Partial<ApiHttpError>);
    }
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not turn a 403 into a 401 callback", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal("fetch", async () => Response.json({ error: "admin origin is not allowed" }, { status: 403 }));
    await expect(http("/api/admin/books")).rejects.toMatchObject({ status: 403 });
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
