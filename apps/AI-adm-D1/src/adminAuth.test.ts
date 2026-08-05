// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAdminAuthHeaders,
  clearAdminToken,
  getAdminToken,
  installAdminFetchInterceptor,
  isAdminApiRequest,
  setAdminToken
} from "./adminAuth";

const ADMIN_AUTH_EXPIRED_EVENT = "ai-quest:admin-auth-expired";
const FETCH_INTERCEPTOR_MARK = "__aiQuestAdminFetchInstalled";

function authRequiredResponse(): Response {
  return new Response(JSON.stringify({ error: "admin authentication required", code: "ADMIN_AUTH_REQUIRED" }), {
    status: 401,
    headers: { "content-type": "application/json", "x-admin-auth-state": "invalid" }
  });
}

function authRequiredResponseCodeOnly(): Response {
  // Same marker, but signalled only via the JSON body code — no header. Exercises
  // the fallback body-parse path in isAdminAuthRequiredResponse.
  return new Response(JSON.stringify({ error: "admin authentication required", code: "ADMIN_AUTH_REQUIRED" }), {
    status: 401,
    headers: { "content-type": "application/json" }
  });
}

function plainResponse(status: number, body: Record<string, unknown> = { error: "nope" }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Reinstalls a fresh interceptor bound to `mockFetch`, bypassing the once-per-window guard. */
function installWithMockFetch(mockFetch: typeof fetch): void {
  delete (window as typeof window & { [FETCH_INTERCEPTOR_MARK]?: boolean })[FETCH_INTERCEPTOR_MARK];
  window.fetch = mockFetch;
  installAdminFetchInterceptor();
}

function countExpiredEvents(): { count: () => number } {
  let count = 0;
  window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, () => { count += 1; });
  return { count: () => count };
}

describe("admin browser authentication", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("stores the token only for the current browser session and clears it on logout", () => {
    setAdminToken("  test-admin-token  ");
    expect(getAdminToken()).toBe("test-admin-token");

    clearAdminToken();
    expect(getAdminToken()).toBeNull();
  });

  it("adds the admin token without overwriting an explicit authorization header", () => {
    setAdminToken("test-admin-token");
    expect(buildAdminAuthHeaders().get("x-admin-token")).toBe("test-admin-token");

    const explicit = buildAdminAuthHeaders({ Authorization: "Bearer explicit-token" });
    expect(explicit.get("authorization")).toBe("Bearer explicit-token");
    expect(explicit.has("x-admin-token")).toBe(false);
  });

  it("only classifies same-origin admin API requests as protected", () => {
    expect(isAdminApiRequest("/api/admin/books")).toBe(true);
    expect(isAdminApiRequest("/api/books")).toBe(false);
    expect(isAdminApiRequest("https://example.com/api/admin/books")).toBe(false);
  });
});

describe("installAdminFetchInterceptor session-invalidation rules", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("clears the session on a 401 marked via the X-Admin-Auth-State header", async () => {
    setAdminToken("token-a");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => authRequiredResponse()));

    await fetch("/api/admin/qm/status");

    expect(getAdminToken()).toBeNull();
    expect(events.count()).toBe(1);
  });

  it("clears the session on a 401 marked only via the ADMIN_AUTH_REQUIRED body code", async () => {
    setAdminToken("token-a");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => authRequiredResponseCodeOnly()));

    await fetch("/api/admin/qm/status");

    expect(getAdminToken()).toBeNull();
    expect(events.count()).toBe(1);
  });

  it("does not clear the session on an unmarked business 401", async () => {
    setAdminToken("token-a");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => plainResponse(401, { error: "alert not found", code: "alert_not_found" })));

    await fetch("/api/admin/ai-evaluation-alerts/x/acknowledge", { method: "POST" });

    expect(getAdminToken()).toBe("token-a");
    expect(events.count()).toBe(0);
  });

  it.each([403, 409, 422, 500])("does not clear the session on a %d response", async (status) => {
    setAdminToken("token-a");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => plainResponse(status)));

    await fetch("/api/admin/qm/status");

    expect(getAdminToken()).toBe("token-a");
    expect(events.count()).toBe(0);
  });

  it("does not clear an existing session when a request with no token gets a marked 401", async () => {
    // No token in storage at all: the request goes out with no x-admin-token,
    // so there is nothing this response could be invalidating.
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => authRequiredResponse()));

    await fetch("/api/admin/qm/status");

    expect(getAdminToken()).toBeNull();
    expect(events.count()).toBe(0);
  });

  it("does not clear a freshly-set token when a stale token's 401 resolves late", async () => {
    setAdminToken("old-token");
    const events = countExpiredEvents();

    let resolveStale!: (response: Response) => void;
    const stalePending = new Promise<Response>((resolve) => { resolveStale = resolve; });
    const mockFetch = vi.fn(async () => stalePending);
    installWithMockFetch(mockFetch as unknown as typeof fetch);

    const inFlight = fetch("/api/admin/qm/status"); // dispatched while token is "old-token"
    setAdminToken("new-token"); // a fresh login completes before the stale response arrives
    resolveStale(authRequiredResponse());
    await inFlight;

    expect(getAdminToken()).toBe("new-token");
    expect(events.count()).toBe(0);
  });

  it("triggers exactly one clear and one expired event for 10 concurrent marked 401s", async () => {
    setAdminToken("token-a");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => authRequiredResponse()));

    await Promise.all(Array.from({ length: 10 }, () => fetch("/api/admin/qm/status")));

    expect(getAdminToken()).toBeNull();
    expect(events.count()).toBe(1);
  });

  it("does not misclear an existing session when a wrong-password login probe 401s", async () => {
    // Simulates AdminLoginPage: an existing valid session is active, and the
    // user (re-)submits a *different*, wrong candidate password explicitly as
    // the x-admin-token header. The probe's 401 must not log out the real
    // session, because the token this specific request carried never matched
    // what is currently stored.
    setAdminToken("real-session-token");
    const events = countExpiredEvents();
    installWithMockFetch(vi.fn(async () => authRequiredResponse()));

    await fetch("/api/admin/qm/status", { headers: { "x-admin-token": "wrong-candidate" } });

    expect(getAdminToken()).toBe("real-session-token");
    expect(events.count()).toBe(0);
  });

  it("preserves method/body/signal for both a Request object and a string URL", async () => {
    setAdminToken("token-a");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => plainResponse(200, { ok: true }));
    installWithMockFetch(mockFetch as unknown as typeof fetch);

    const controller = new AbortController();
    const requestObject = new Request("/api/admin/ai-providers", {
      method: "POST",
      body: JSON.stringify({ slug: "x" }),
      signal: controller.signal
    });
    await fetch(requestObject);
    await fetch("/api/admin/ai-providers", { method: "PUT", body: JSON.stringify({ slug: "y" }) });

    const [firstArg] = mockFetch.mock.calls[0] as [Request];
    expect(firstArg).toBeInstanceOf(Request);
    expect(firstArg.method).toBe("POST");
    expect(await firstArg.clone().text()).toBe(JSON.stringify({ slug: "x" }));
    expect(firstArg.signal.aborted).toBe(false);
    controller.abort();
    expect(firstArg.signal.aborted).toBe(true);

    const [, secondInit] = mockFetch.mock.calls[1] as [RequestInfo | URL, RequestInit | undefined];
    expect(secondInit?.method).toBe("PUT");
    expect(secondInit?.body).toBe(JSON.stringify({ slug: "y" }));
  });
});
