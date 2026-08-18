// @vitest-environment happy-dom
import { afterEach, expect, it, describe } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { StudentAppRoutes } from "./App";
import { dashboardProfileFromSession } from "./dashboard/dashboardQueries";
import {
  completeStudentProfileViaRawHttp,
  oauthLoginViaRawHttp,
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
let googleSubject = "google-subject";

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
  googleSubject = "google-subject";
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

async function loginViaRealOAuth(baseUrl: string, displayName?: string): Promise<void> {
  // Real OAuth round-trip over raw TCP against the express auth router.
  sessionCookie = await oauthLoginViaRawHttp(baseUrl);
  if (displayName) await completeStudentProfileViaRawHttp(baseUrl, sessionCookie, displayName);
}

describe("Student router + real session boundary (H-4)", () => {
  it("sends unauthenticated visitors from /dashboard, /books and /books/:bookId to /login and never exposes book content", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT, fakeProvider: { getSubject: () => googleSubject } });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    // Forged identity claims in localStorage must not authenticate anyone.
    localStorage.setItem("smartbook.student.name", "Forged Name");
    localStorage.setItem("smartbook.student.authenticated", "true");

    for (const path of ["/dashboard", "/books", "/books/book-alpha"]) {
      await renderAt(path);
      await waitForPath("/login");
      const html = container?.innerHTML ?? "";
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
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT, fakeProvider: { getSubject: () => googleSubject } });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealOAuth(app.baseUrl, "Real Session Student");
    localStorage.setItem("smartbook.student.name", "Forged Name");

    await renderAt("/dashboard");
    await waitForPath("/dashboard");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const html = container?.innerHTML ?? "";
    expect(html).toContain("已登入學員");
    expect(html).toContain("Real Session Student");
    expect(html).not.toContain("Forged Name");
  });

  it("routes an authenticated user with an incomplete profile to /profile-completion, then back to /dashboard", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, port: TEST_PORT, fakeProvider: { getSubject: () => googleSubject } });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    googleSubject = "google-subject-incomplete";
    await loginViaRealOAuth(app.baseUrl);

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
    app = await startStudentTestApp({ sessionTtlMs: 300, port: TEST_PORT, fakeProvider: { getSubject: () => googleSubject } });
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${TEST_PORT}/`);
    installBrowserFetch(app.baseUrl);
    await loginViaRealOAuth(app.baseUrl, "Expiring Student");

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
});
