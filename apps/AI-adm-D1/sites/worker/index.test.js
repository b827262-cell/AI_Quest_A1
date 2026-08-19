import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const ADMIN_API_UPSTREAM_ORIGIN = "https://admin-api.b827262.org";

function makeAssetsStub(responseFactory) {
  return { fetch: vi.fn(responseFactory) };
}

describe("Admin Sites worker: /api/admin/* proxy", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("forwards GET requests to the fixed upstream with method and query preserved", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ authenticated: false }), { status: 401 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session?foo=bar", {
      method: "GET"
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(upstreamRequest.url).toBe(`${ADMIN_API_UPSTREAM_ORIGIN}/api/admin/auth/session?foo=bar`);
    expect(upstreamRequest.method).toBe("GET");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("forwards POST request body and Content-Type unchanged", async () => {
    let capturedBody;
    fetchSpy.mockImplementation(async (req) => {
      capturedBody = await req.text();
      return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
    });

    const payload = JSON.stringify({ username: "admin", password: "does-not-matter-here" });
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(upstreamRequest.method).toBe("POST");
    expect(upstreamRequest.headers.get("content-type")).toBe("application/json");
    expect(capturedBody).toBe(payload);
    expect(response.status).toBe(200);
  });

  it("forwards the Cookie header to the upstream", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/me", {
      headers: { Cookie: "ai_admin_session=abc123; ai_admin_csrf=xyz789" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(upstreamRequest.headers.get("cookie")).toBe("ai_admin_session=abc123; ai_admin_csrf=xyz789");
  });

  it("forwards the X-CSRF-Token header to the upstream", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": "csrf-token-value" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(upstreamRequest.headers.get("x-csrf-token")).toBe("csrf-token-value");
    expect(response.status).toBe(204);
  });

  it("forwards the Origin header unchanged so backend origin/CSRF checks see the real browser origin", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session", {
      headers: { Origin: "https://ai-quest-a1-admin.b827262.chatgpt.site" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(upstreamRequest.headers.get("origin")).toBe("https://ai-quest-a1-admin.b827262.chatgpt.site");
  });

  it("always targets the fixed upstream host regardless of a client-supplied Host header", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session", {
      headers: { Host: "evil.example" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(new URL(upstreamRequest.url).host).toBe("admin-api.b827262.org");
    expect(upstreamRequest.headers.get("host")).toBe("admin-api.b827262.org");
  });

  it("always targets the fixed upstream host regardless of a client-supplied X-Forwarded-Host header", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session", {
      headers: { "X-Forwarded-Host": "evil.example" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(new URL(upstreamRequest.url).host).toBe("admin-api.b827262.org");
    expect(upstreamRequest.headers.has("x-forwarded-host")).toBe(false);
  });

  it("ignores any attempt to redirect the upstream via query or path segments (base origin cannot be escaped)", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const request = new Request(
      "https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session?next=https://evil.example",
      { method: "GET" }
    );
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    const upstreamRequest = fetchSpy.mock.calls[0][0];
    expect(new URL(upstreamRequest.url).host).toBe("admin-api.b827262.org");
    expect(new URL(upstreamRequest.url).pathname).toBe("/api/admin/auth/session");
  });

  it("strips Domain=.b827262.org from a single Set-Cookie header while preserving every other attribute and the value", async () => {
    fetchSpy.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "set-cookie":
            "ai_admin_session=tok3n-value; Domain=.b827262.org; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict"
        }
      })
    );

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/login", {
      method: "POST"
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toMatch(/domain=/i);
    expect(cookies[0]).toContain("ai_admin_session=tok3n-value");
    expect(cookies[0]).toContain("Path=/");
    expect(cookies[0]).toContain("Max-Age=28800");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
    expect(cookies[0]).toContain("SameSite=Strict");
  });

  it("handles multiple Set-Cookie headers independently without merging them into one cookie string", async () => {
    const upstreamHeaders = new Headers();
    upstreamHeaders.append(
      "set-cookie",
      "ai_admin_session=session-token; Domain=.b827262.org; Path=/; HttpOnly; Secure; SameSite=Strict"
    );
    upstreamHeaders.append(
      "set-cookie",
      "ai_admin_csrf=csrf-token; Domain=.b827262.org; Path=/; Secure; SameSite=Strict"
    );
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200, headers: upstreamHeaders }));

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/login", {
      method: "POST"
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const session = cookies.find((c) => c.startsWith("ai_admin_session="));
    const csrf = cookies.find((c) => c.startsWith("ai_admin_csrf="));
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    expect(session).not.toMatch(/domain=/i);
    expect(csrf).not.toMatch(/domain=/i);
    expect(session).toContain("HttpOnly");
    // CSRF cookie must remain readable by the SPA: no HttpOnly attribute.
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("Secure");
    expect(csrf).toContain("SameSite=Strict");
  });

  it("does not alter the cookie value itself while stripping Domain", async () => {
    fetchSpy.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "set-cookie": "ai_admin_csrf=Ab12-Cd34_Ef56.Gh78~Ij90; Domain=.b827262.org; Path=/; Secure; SameSite=Strict"
        }
      })
    );

    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/login", {
      method: "POST"
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie.split(";")[0].trim()).toBe("ai_admin_csrf=Ab12-Cd34_Ef56.Gh78~Ij90");
  });

  it("preserves a 401 status and body from the upstream", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/session");
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("preserves a 403 status and body from the upstream", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "admin origin is not allowed" }), { status: 403 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/login", {
      method: "POST",
      headers: { Origin: "https://evil.example" }
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "admin origin is not allowed" });
  });

  it("preserves a 204 No Content status from the upstream (e.g. logout)", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin/auth/logout", {
      method: "POST"
    });
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(204);
  });

  it("matches /api/admin exactly (no trailing slash) as a proxied path too", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/admin");
    const env = { ASSETS: makeAssetsStub(() => new Response("not used")) };

    await worker.fetch(request, env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Admin Sites worker: SPA and non-admin-API routes are unaffected by the proxy", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("serves the SPA index for a deep client-side route without calling fetch()", async () => {
    const assetsFetch = vi.fn(async (req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname === "/") return new Response("<html>spa shell</html>", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/login");
    const env = { ASSETS: { fetch: assetsFetch } };

    const response = await worker.fetch(request, env);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>spa shell</html>");
  });

  it("serves a static asset directly without proxying or SPA fallback", async () => {
    const assetsFetch = vi.fn(async () => new Response("body{color:red}", { status: 200 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/assets/index-abc123.css");
    const env = { ASSETS: { fetch: assetsFetch } };

    const response = await worker.fetch(request, env);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("does not proxy a non-admin /api/ path (e.g. /api/public/*) and does not SPA-fallback it either", async () => {
    const assetsFetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/api/public/site-config");
    const env = { ASSETS: { fetch: assetsFetch } };

    const response = await worker.fetch(request, env);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

  it("falls back to the SPA index for a genuinely unknown non-API GET path", async () => {
    const assetsFetch = vi.fn(async (req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname === "/") return new Response("<html>spa shell</html>", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const request = new Request("https://ai-quest-a1-admin.b827262.chatgpt.site/dashboard");
    const env = { ASSETS: { fetch: assetsFetch } };

    const response = await worker.fetch(request, env);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
