import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  completeSmokeProfile,
  createSmokeBrowser,
  createThrowawayDir,
  GateReport,
  loginViaSmokeOAuth,
  rawHttpRequest,
  seedThrowawayStudentDb,
  startFakeGoogleProvider,
  startStudentApi,
  type StudentApiHandle
} from "./student-smoke-harness";

/**
 * student:auth-smoke — exercises the REAL student API process over HTTP:
 * deterministic OAuth fixture -> session cookie -> refresh -> profile gate
 * -> protected routes -> session expiry -> logout revocation -> replays.
 */

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address !== "string") resolvePort(address.port);
        else rejectPort(new Error("no free port"));
      });
    });
  });
}

async function main(): Promise<void> {
  const report = new GateReport();
  const directory = createThrowawayDir("ai-quest-auth-smoke-");
  const studentDbPath = join(directory, "student.db");
  seedThrowawayStudentDb(studentDbPath);

  const provider = await startFakeGoogleProvider();
  let app: StudentApiHandle | null = null;
  let expiryApp: StudentApiHandle | null = null;

  try {
    const port = await getFreePort();
    app = await startStudentApi({
      port,
      studentDbPath,
      authDbPath: join(directory, "auth.db"),
      sessionTtlMs: 3_600_000,
      googleEndpoints: {
        authorize: `${provider.baseUrl}/authorize`,
        token: `${provider.baseUrl}/token`,
        userinfo: `${provider.baseUrl}/userinfo`
      }
    });
    const origin = app.baseUrl;
    const browser = createSmokeBrowser(app.baseUrl, origin);

    // 1. Protected routes refuse anonymous traffic.
    for (const path of ["/api/student/books", "/api/student/books/book-alpha", "/api/student/books/book-alpha/rag-ask"]) {
      const anonymous = await browser.request(path, path.endsWith("rag-ask") ? { method: "POST", body: { query: "光合作用" } } : undefined);
      report.expect(anonymous.status === 401, `anonymous ${path} rejected`, `status=${anonymous.status}`);
    }

    // 2. Deterministic OAuth round trip through the real routes.
    const start = await browser.request("/api/student/auth/google/start?returnTo=%2Fdashboard");
    report.expect(start.status === 302, "google/start redirects to provider");
    const authorizationUrl = new URL(start.headers["location"]?.[0] ?? "");
    report.expect(authorizationUrl.searchParams.has("state"), "authorization url carries one-time state");
    report.expect(authorizationUrl.searchParams.has("code_challenge"), "authorization url carries PKCE code_challenge");
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const callback = await browser.request(`/api/student/auth/google/callback?state=${encodeURIComponent(state)}&code=deterministic-auth-code`);
    report.expect(callback.status === 302, "callback establishes session and redirects");
    const rawCookies = callback.headers["set-cookie"] ?? [];
    const sessionSetCookie = rawCookies.find((entry) => entry.startsWith("ai_student_session="));
    report.expect(Boolean(sessionSetCookie), "session cookie issued");
    report.expect(/httponly/i.test(String(sessionSetCookie)), "session cookie is HttpOnly");
    report.expect(/secure/i.test(String(sessionSetCookie)), "session cookie is Secure");
    report.expect(/samesite=strict/i.test(String(sessionSetCookie)), "session cookie is SameSite=Strict");

    // 3. /me reflects the fresh session; refresh keeps the login alive.
    const me = await browser.request("/api/student/auth/me");
    const meBody = JSON.parse(me.bodyText);
    report.expect(me.status === 200 && meBody.authenticated === true, "session cookie authenticates /me");
    report.expect(meBody.user?.profileCompleted === false, "new account has incomplete profile");
    const meAgain = await browser.request("/api/student/auth/me");
    report.expect(JSON.parse(meAgain.bodyText).authenticated === true, "refresh keeps the session authenticated");

    // 4. Profile gate: private data stays closed until completion.
    const gated = await browser.request("/api/student/books");
    report.expect(gated.status === 403, "incomplete profile blocks protected data", `status=${gated.status}`);
    await completeSmokeProfile(browser, "Smoke Student");
    const meCompleted = JSON.parse((await browser.request("/api/student/auth/me")).bodyText);
    report.expect(meCompleted.user?.profileCompleted === true, "profile completion persisted");
    const books = await browser.request("/api/student/books");
    report.expect(books.status === 200, "completed profile unlocks protected routes");
    report.expect(JSON.parse(books.bodyText).books.length === 2, "protected route serves seeded books");

    // 5. OAuth state replay fails closed.
    const replayState = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/google/callback?state=${encodeURIComponent(state)}&code=deterministic-auth-code`));
    report.expect(replayState.status === 400 && JSON.parse(replayState.bodyText).error === "OAUTH_STATE_INVALID", "OAuth state replay rejected");

    // 6. Logout revokes the session; the old cookie cannot be replayed.
    const staleCookie = browser.cookie;
    const logout = await browser.request("/api/student/auth/logout", { method: "POST" });
    report.expect(logout.status === 204, "logout succeeds");
    browser.cookie = staleCookie;
    const replayed = await browser.request("/api/student/books");
    report.expect(replayed.status === 401, "revoked session cookie cannot be replayed", `status=${replayed.status}`);
    const meAfterLogout = JSON.parse((await browser.request("/api/student/auth/me")).bodyText);
    report.expect(meAfterLogout.authenticated === false, "/me reports anonymous after logout");

    // 7. Session expiry on an isolated short-TTL server.
    const expiryPort = await getFreePort();
    expiryApp = await startStudentApi({
      port: expiryPort,
      studentDbPath,
      authDbPath: join(directory, "auth-expiry.db"),
      sessionTtlMs: 400,
      googleEndpoints: {
        authorize: `${provider.baseUrl}/authorize`,
        token: `${provider.baseUrl}/token`,
        userinfo: `${provider.baseUrl}/userinfo`
      }
    });
    const expiryBrowser = createSmokeBrowser(expiryApp.baseUrl, expiryApp.baseUrl);
    await loginViaSmokeOAuth(expiryApp.baseUrl, expiryBrowser);
    await completeSmokeProfile(expiryBrowser, "Expiring Student");
    report.expect(JSON.parse((await expiryBrowser.request("/api/student/auth/me")).bodyText).authenticated === true, "short-TTL session authenticates before expiry");
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    const expired = await expiryBrowser.request("/api/student/books");
    report.expect(expired.status === 401, "expired session is rejected", `status=${expired.status}`);

    console.log(`\nstudent:auth-smoke PASS (${report.steps.length} checks)`);
  } finally {
    await Promise.allSettled([app?.close(), expiryApp?.close(), provider.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("\nstudent:auth-smoke FAIL");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
