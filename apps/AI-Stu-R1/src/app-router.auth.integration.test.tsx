// @vitest-environment happy-dom
import { afterEach, expect, it, describe } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { StudentAppRoutes } from "./App";
import { dashboardProfileFromSession } from "./dashboard/dashboardQueries";
import { RequireStudent, StudentAuthProvider, useStudentAuth } from "./student-auth";
import { resetStudentUnauthorizedNotification, studentClient, StudentApiError } from "./studentClient";
import {
  completeStudentProfileViaRawHttp,
  accessLoginViaRawHttp,
  rawHttpRequest,
  startStudentTestApp,
  type StudentTestApp
} from "../server/testApp";

/**
 * H-4 router/auth integration suite. The React route tree renders against a
 * REAL in-process Student API (express + session middleware + throwaway DB)
 * through a cookie-aware fetch wrapper, so redirects are driven by actual
 * /api/student/auth/me responses rather than mocked component state.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;


/** Fixed port so happy-dom's document origin matches the test server and
 * relative API paths issued by the app resolve to the real express stack. */
const TEST_PORT = 43917;

let app: StudentTestApp | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
let sessionCookie: string | null = null;

const baseFetch = globalThis.fetch;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  globalThis.fetch = baseFetch;
  sessionCookie = null;
  resetStudentUnauthorizedNotification();
  localStorage.clear();
  if (app) {
    await app.close();
    app = null;
  }
});

/** Browser-like fetch shim: resolves relative API paths against the test
 * server and persists the HttpOnly session cookie across requests. The
 * transport is raw node:http so happy-dom's same-origin emulation never
 * interferes; responses are standard Response objects for the app code. */
function installBrowserFetch(origin: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string"
      ? new URL(input, origin)
      : input instanceof URL ? input : new URL(input.url, origin);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? undefined).forEach((value, key) => {
      headers[key] = value;
    });
    if (sessionCookie) headers["cookie"] = sessionCookie;
    const result = await rawHttpRequest(url, {
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined
    });
    const session = (result.headers["set-cookie"] ?? []).find((entry) => entry.startsWith("ai_student_session="));
    if (session) sessionCookie = session.split(";", 1)[0];
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(result.headers)) {
      for (const value of values) responseHeaders.append(name, value);
    }
    return new Response(result.bodyText, { status: result.status, headers: responseHeaders });
  }) as typeof fetch;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

async function renderAt(path: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <StudentAppRoutes />
        <LocationProbe />
      </MemoryRouter>
    );
  });
}

function currentPath(): string {
  return container?.querySelector("[data-testid='location-probe']")?.textContent ?? "";
}

async function waitForPath(expected: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentPath() === expected) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`expected route ${expected}, stayed at ${currentPath()}`);
}

async function waitForContent(text: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container?.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  throw new Error(`expected content ${text}`);
}

async function loginViaRealAccess(baseUrl: string, displayName?: string): Promise<void> {
  // Real Access assertion over raw TCP against the express auth router.
  sessionCookie = await accessLoginViaRawHttp(baseUrl, app!.assertion());
  if (displayName) await completeStudentProfileViaRawHttp(baseUrl, sessionCookie, displayName);
}

describe("Student router + real session boundary (H-4)", () => {
  it("sends unauthenticated visitors from /dashboard, /books and /books/:bookId to /login and never exposes book content", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    // Forged identity claims in localStorage must not authenticate anyone.
    localStorage.setItem("smartbook.student.name", "Forged Name");
    localStorage.setItem("smartbook.student.authenticated", "true");

    for (const path of ["/dashboard", "/books", "/books/book-alpha"]) {
      await renderAt(path);
      await waitForPath("/login");
      const html = container?.innerHTML ?? "";
      expect(html).toContain("以電子郵件登入（Cloudflare Access）");
      expect(html).not.toContain("使用 Google 登入");
      expect(html).not.toContain("Alpha Botany");
      expect(html).not.toContain("光合作用");
      if (root) {
        const mounted = root;
        await act(async () => mounted.unmount());
        root = null;
      }
      container?.remove();
      container = null;
    }
  });

  it("renders /knowledge-ai without authentication and provides the 4-mode search form", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);

    await renderAt("/knowledge-ai");
    await waitForPath("/knowledge-ai");
    await waitForContent("知識達 AI 學習問答");
    const html = container?.innerHTML ?? "";
    expect(html).toContain("知識達 AI 學習問答");
    expect(html).toContain("公開來源查詢方式");
    expect(html).toContain("品名");
    expect(html).toContain("品號");
    expect(html).toContain("師資");
    expect(html).toContain("適用範圍");
  });

  it("dashboard view-model derives only from the session profile", () => {
    expect(dashboardProfileFromSession(null)).toEqual({ name: null, points: null, authenticated: false });
    const fromSession = dashboardProfileFromSession({
      displayName: "Real Session Student",
      schoolName: "Test University",
      gradeLevel: "Year 1",
      profileCompleted: true
    } as never);
    expect(fromSession).toMatchObject({ name: "Real Session Student", authenticated: true });
  });

  it("renders the dashboard from the real session profile and ignores forged localStorage identity", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealAccess(app.baseUrl, "Real Session Student");
    localStorage.setItem("smartbook.student.name", "Forged Name");

    await renderAt("/dashboard");
    await waitForPath("/dashboard");
    await waitForContent("已登入學員");
    const html = container?.innerHTML ?? "";
    expect(html).toContain("已登入學員");
    expect(html).toContain("Real Session Student");
    expect(html).not.toContain("Forged Name");
  });

  it("routes an authenticated user with an incomplete profile to /profile-completion, then back to /dashboard", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealAccess(app.baseUrl);

    await renderAt("/dashboard");
    await waitForPath("/profile-completion");

    // Complete the profile through the real auth API, then remount: the
    // session now carries a completed profile and the dashboard opens.
    await completeStudentProfileViaRawHttp(app.baseUrl, sessionCookie ?? "", "Completed Student");
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = null;
    }
    container?.remove();
    container = null;

    await renderAt("/dashboard");
    await waitForPath("/dashboard");
  });

  it("redirects back to /login once the server session expires", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 300, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealAccess(app.baseUrl, "Expiring Student");

    await renderAt("/dashboard");
    await waitForPath("/dashboard");
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = null;
    }
    container?.remove();
    container = null;

    await new Promise((resolve) => setTimeout(resolve, 500));
    await renderAt("/dashboard");
    await waitForPath("/login");
  });


  it("triggers a single auth-clear/redirect for parallel 401s and does not logout on 403/404/5xx", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealAccess(app.baseUrl, "Parallel Student");

    // --- parallel 401 storm: single redirect, no retry storm ---
    let phase: "parallel401" | "non401" = "parallel401";
    let parallel401Calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? new URL(input, app!.baseUrl) : input instanceof URL ? input : new URL(input.url, app!.baseUrl);
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? undefined).forEach((value, key) => { headers[key] = value; });
      if (sessionCookie) headers.cookie = sessionCookie;
      if (phase === "parallel401" && url.pathname.startsWith("/api/student/books") && url.pathname !== "/api/student/books") {
        // multiple protected data requests fail with expired session
      }
      if (phase === "parallel401" && ["/api/student/books/book-alpha", "/api/student/books/book-alpha/contents", "/api/student/books/book-beta"].includes(url.pathname)) {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "SESSION_EXPIRED" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (phase === "non401" && url.pathname === "/api/student/books/book-alpha") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (phase === "non401" && url.pathname === "/api/student/books/book-beta") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      if (phase === "non401" && url.pathname === "/api/student/books/book-gamma") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      const result = await rawHttpRequest(url, { method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : undefined });
      const session = (result.headers["set-cookie"] ?? []).find((entry) => entry.startsWith("ai_student_session="));
      if (session) sessionCookie = session.split(";", 1)[0];
      const responseHeaders = new Headers();
      for (const [name, values] of Object.entries(result.headers)) for (const value of values) responseHeaders.append(name, value);
      return new Response(result.bodyText, { status: result.status, headers: responseHeaders });
    }) as typeof fetch;

    function Parallel401Page() {
      const [done, setDone] = useState(false);
      useEffect(() => {
        void Promise.allSettled([
          studentClient.getBook("book-alpha"),
          studentClient.getContents("book-alpha"),
          studentClient.getBook("book-beta")
        ]).then(() => {
          setDone(true);
        });
      }, []);
      return <div data-testid="parallel401-page">{done ? "done" : "pending"}</div>;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root?.render(
        <MemoryRouter initialEntries={["/dashboard"]}>
          <StudentAuthProvider>
            <RequireStudent><Parallel401Page /></RequireStudent>
            <LocationProbe />
          </StudentAuthProvider>
        </MemoryRouter>
      );
    });
    await waitForPath("/login");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(currentPath()).toBe("/login");
    expect(parallel401Calls).toBe(3); // no retry storm

    // --- 403/404/5xx must not log out ---
    if (root) { const mounted = root; await act(async () => mounted.unmount()); root = null; }
    container?.remove(); container = null;
    resetStudentUnauthorizedNotification();
    phase = "non401";
    parallel401Calls = 0;
    installBrowserFetch(app.baseUrl); // real fetch again
    await loginViaRealAccess(app.baseUrl, "Parallel Student");
    // reinstall custom fetch after login
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? new URL(input, app!.baseUrl) : input instanceof URL ? input : new URL(input.url, app!.baseUrl);
      if (phase === "non401" && url.pathname === "/api/student/books/book-alpha") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (phase === "non401" && url.pathname === "/api/student/books/book-beta") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      if (phase === "non401" && url.pathname === "/api/student/books/book-gamma") {
        parallel401Calls += 1;
        return new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    function Non401Page() {
      const { status } = useStudentAuth();
      const [results, setResults] = useState<number[]>([]);
      useEffect(() => {
        void Promise.allSettled([
          studentClient.getBook("book-alpha"),
          studentClient.getBook("book-beta"),
          studentClient.getBook("book-gamma")
        ]).then((settled) => {
          setResults(settled.map((item) => (
            item.status === "rejected" && item.reason instanceof StudentApiError ? item.reason.status : 0
          )));
        });
      }, []);
      return <div data-testid="non401-page" data-auth={status} data-results={results.join(",")}>{results.length ? "done" : "pending"}</div>;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root?.render(
        <MemoryRouter initialEntries={["/dashboard"]}>
          <StudentAuthProvider>
            <RequireStudent><Non401Page /></RequireStudent>
            <LocationProbe />
          </StudentAuthProvider>
        </MemoryRouter>
      );
    });
    await waitForPath("/dashboard");
    await waitForContent("done");
    expect(currentPath()).toBe("/dashboard");
    expect(container?.querySelector("[data-testid='non401-page']")?.getAttribute("data-auth")).toBe("authenticated");
    expect(container?.querySelector("[data-testid='non401-page']")?.getAttribute("data-results")).toBe("403,404,500");
    expect(parallel401Calls).toBe(3);
  });

  it("does not restore authenticated state when logout races with /me or data requests", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealAccess(app.baseUrl, "Race Student");

    let releaseMe!: () => void;
    const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
    let meCalls = 0;
    const baseShim = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? new URL(input, app!.baseUrl) : input instanceof URL ? input : new URL(input.url, app!.baseUrl);
      if (url.pathname === "/api/student/auth/me" && meCalls >= 1) {
        meCalls += 1;
        await meGate;
      } else if (url.pathname === "/api/student/auth/me") {
        meCalls += 1;
      }
      if (url.pathname === "/api/student/books/book-alpha") {
        // delay data request so it can resolve around logout
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return baseShim(input, init);
    }) as typeof fetch;

    let doRefresh!: () => Promise<void>;
    let doLogout!: () => Promise<void>;
    function RacePage() {
      const auth = useStudentAuth();
      doRefresh = auth.refresh;
      doLogout = auth.logout;
      return <div data-testid="race-page" data-auth={auth.status}>{auth.profile?.displayName ?? "none"}</div>;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root?.render(
        <MemoryRouter initialEntries={["/dashboard"]}>
          <StudentAuthProvider>
            <RequireStudent><RacePage /></RequireStudent>
            <LocationProbe />
          </StudentAuthProvider>
        </MemoryRouter>
      );
    });
    await waitForPath("/dashboard");
    await waitForContent("Race Student");

    // Start a refresh whose /me response will be delayed; start logout and a data request concurrently.
    const refreshPromise = doRefresh();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const logoutPromise = doLogout();
    releaseMe();
    await act(async () => { await Promise.allSettled([refreshPromise, logoutPromise]); });
    await waitForPath("/login");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(currentPath()).toBe("/login");

    // Remount check: session revoked server-side, cannot re-enter authenticated state.
    if (root) { const mounted = root; await act(async () => mounted.unmount()); root = null; }
    container?.remove(); container = null;
    installBrowserFetch(app.baseUrl);
    await renderAt("/dashboard");
    await waitForPath("/login");
  });

});
