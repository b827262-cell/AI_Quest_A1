import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  completeSmokeProfile,
  createSmokeBrowser,
  createThrowawayDir,
  GateReport,
  loginViaSmokeAccess,
  rawHttpRequest,
  seedThrowawayStudentDb,
  startStudentApi,
  type StudentApiHandle
} from "./student-smoke-harness";
import { startFakeAccessCerts } from "./student-access-fixture";

/**
 * student:auth-smoke — exercises the REAL student API process over HTTP:
 * deterministic signed Access fixture -> session cookie -> refresh -> profile gate
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

  const certs = await startFakeAccessCerts();
  let app: StudentApiHandle | null = null;
  let expiryApp: StudentApiHandle | null = null;

  try {
    const port = await getFreePort();
    app = await startStudentApi({
      port,
      studentDbPath,
      authDbPath: join(directory, "auth.db"),
      sessionTtlMs: 3_600_000,
      accessCerts: certs
    });
    const origin = app.baseUrl;
    const browser = createSmokeBrowser(app.baseUrl, origin);

    // 1. Protected routes refuse anonymous traffic.
    for (const path of ["/api/student/books", "/api/student/books/book-alpha", "/api/student/books/book-alpha/rag-ask"]) {
      const anonymous = await browser.request(path, path.endsWith("rag-ask") ? { method: "POST", body: { query: "光合作用" } } : undefined);
      report.expect(anonymous.status === 401, `anonymous ${path} rejected`, `status=${anonymous.status}`);
    }

    // 2. Signed Cloudflare Access assertion through the real route.
    const anonymous = await browser.request("/api/student/auth/access/login", {
      headers: { "Cf-Access-Authenticated-User-Email": "forged@example.test", "oai-email": "forged@example.test", cookie: "CF_Authorization=forged" }
    });
    report.expect(anonymous.status === 401, "forged identity headers rejected");
    const callback = await browser.request("/api/student/auth/access/login?returnTo=%2Fdashboard", {
      headers: { "Cf-Access-Jwt-Assertion": certs.assertion() }
    });
    report.expect(callback.status === 302, "signed assertion establishes session and redirects");
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

    // 5. Google routes are disabled and bad assertions fail closed.
    const oldRoute = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/google/start`));
    report.expect(oldRoute.status === 404, "Google login route disabled");
    const invalid = await browser.request("/api/student/auth/access/login", { headers: { "Cf-Access-Jwt-Assertion": certs.assertion({ aud: "wrong" }) } });
    report.expect(invalid.status === 401, "wrong audience rejected");
    certs.setFailure(true);
    const unavailable = await browser.request("/api/student/auth/access/login", {
      headers: { "Cf-Access-Jwt-Assertion": certs.assertion({}, { kid: "unknown-during-jwks-failure" }) }
    });
    report.expect(unavailable.status === 503 && JSON.parse(unavailable.bodyText).error === "ACCESS_UNAVAILABLE", "JWKS refresh failure remains 503");
    certs.setFailure(false);

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
      accessCerts: certs
    });
    const expiryBrowser = createSmokeBrowser(expiryApp.baseUrl, expiryApp.baseUrl);
    await loginViaSmokeAccess(expiryBrowser, certs.assertion());
    await completeSmokeProfile(expiryBrowser, "Expiring Student");
    report.expect(JSON.parse((await expiryBrowser.request("/api/student/auth/me")).bodyText).authenticated === true, "short-TTL session authenticates before expiry");
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    const expired = await expiryBrowser.request("/api/student/books");
    report.expect(expired.status === 401, "expired session is rejected", `status=${expired.status}`);

    console.log(`\nstudent:auth-smoke PASS (${report.steps.length} checks)`);
  } finally {
    await Promise.allSettled([app?.close(), expiryApp?.close(), certs.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("\nstudent:auth-smoke FAIL");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
