import { afterEach, describe, expect, it } from "vitest";
import { rawHttpRequest, startStudentTestApp, type StudentTestApp } from "./testApp";
import { createDbHandle, createRepositories } from "../../../packages/db/src";
import { hashStudentPasscode } from "@ai-smartbook/auth/passcode";

let app: StudentTestApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

function login(assertion?: string, returnTo = "/dashboard", extraHeaders: Record<string, string> = {}) {
  return rawHttpRequest(new URL(`${app!.baseUrl}/api/student/auth/access/login?returnTo=${encodeURIComponent(returnTo)}`), {
    headers: { ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}), ...extraHeaders }
  });
}

describe("Student Cloudflare Access HTTP integration", () => {
  it("omits Secure from the session cookie when explicitly disabled outside production", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, secureCookies: false });
    const response = await login(app.assertion());
    expect(response.status).toBe(302);
    expect(response.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/);
    expect(response.headers["set-cookie"]?.[0]).not.toMatch(/;\s*Secure/i);
  });
  it("creates a session from a signed assertion, gates the profile, and preserves a safe returnTo", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const response = await login(app.assertion({ email: " Student@Example.Test " }), "//attacker.example");
    expect(response.status).toBe(302);
    expect(response.headers.location?.[0]).toBe("/profile-completion?next=%2Fbooks");
    const cookie = response.headers["set-cookie"]?.[0];
    expect(cookie).toMatch(/ai_student_session=.*HttpOnly.*Secure.*SameSite=strict/i);
    expect(cookie).toMatch(/Max-Age=3600/i);
    const session = cookie?.split(";", 1)[0] ?? "";
    const me = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/me`), { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.bodyText)).toMatchObject({ authenticated: true, user: { email: "student@example.test", profileCompleted: false } });
    const gated = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/books`), { headers: { cookie: session } });
    expect(gated.status).toBe(403);
    const profile = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/profile`), {
      method: "PATCH", headers: { cookie: session, origin: "https://student.example.test", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Student", schoolName: "School", gradeLevel: "1" })
    });
    expect(profile.status).toBe(200);
    expect(JSON.parse(profile.bodyText)).toMatchObject({ profile: { profileCompleted: true } });
    expect((await rawHttpRequest(new URL(`${app.baseUrl}/api/student/books`), { headers: { cookie: session } })).status).toBe(200);
    const next = await login(app.assertion(), "/dashboard");
    expect(next.headers.location?.[0]).toBe("/dashboard");
    expect(app.certs.requestCount()).toBe(1); // JWKS reused across requests.
    expect((await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/google/start`))).status).toBe(404);
    expect((await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/google/callback`))).status).toBe(404);
  });

  it("rejects missing, forged, expired, premature, wrong kid, audience and issuer assertions", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const now = Math.floor(Date.now() / 1000);
    const forgedHeaders = { "Cf-Access-Authenticated-User-Email": "forged@example.test", cookie: "CF_Authorization=forged", "oai-email": "forged@example.test" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = await login(undefined, "/dashboard", forgedHeaders);
      expect(missing.status).toBe(401);
      expect(JSON.parse(missing.bodyText)).toEqual({ error: "ACCESS_ASSERTION_INVALID" });
    }
    const parts = app.assertion().split(".");
    const forged = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    for (const token of [
      app.assertion({ exp: now - 300 }),
      app.assertion({ nbf: now + 300 }),
      app.assertion({ iat: now + 300 }),
      app.assertion({}, { kid: "wrong-kid" }),
      app.assertion({ aud: "wrong-aud" }),
      app.assertion({ iss: "https://evil.example.test" }),
      forged
    ]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await login(token, "/dashboard", forgedHeaders);
        expect(response.status).toBe(401);
        expect(JSON.parse(response.bodyText)).toEqual({ error: "ACCESS_ASSERTION_INVALID" });
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    }
  });

  it("rejects repeated expired assertions without issuing a session", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const expired = app.assertion({ exp: Math.floor(Date.now() / 1000) - 61 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await login(expired);
      expect(response.status).toBe(401);
      expect(JSON.parse(response.bodyText)).toEqual({ error: "ACCESS_ASSERTION_INVALID" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("returns 503 for absent config and unavailable certs", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const token = app.assertion();
    app.config.accessAud = undefined;
    const missingConfig = await login(token);
    expect(missingConfig.status).toBe(503);
    expect(JSON.parse(missingConfig.bodyText)).toEqual({ error: "ACCESS_UNAVAILABLE" });
    app.config.accessAud = app.certs.aud;
    app.certs.setFailure(true);
    const unavailable = await login(token);
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.bodyText)).toEqual({ error: "ACCESS_UNAVAILABLE" });
    expect(unavailable.headers["set-cookie"]).toBeUndefined();
  });

  it("accepts only same-site relative return targets", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    for (const target of ["https://evil.example/path", "//evil.example/path"]) {
      const response = await login(app.assertion(), target);
      expect(response.status).toBe(302);
      expect(response.headers.location?.[0]).toBe("/profile-completion?next=%2Fbooks");
    }
    const response = await login(app.assertion(), "/dashboard?tab=books");
    expect(response.headers.location?.[0]).toBe("/profile-completion?next=%2Fdashboard%3Ftab%3Dbooks");
  });

  it("matches an existing Google user by verified email despite legacy case and whitespace", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const users = createRepositories(app.runtime.dbHandle.db).studentUsers;
    const old = users.create({ googleSubject: "old-google-subject", email: " Student@Example.Test ", displayName: "Old Student" });
    users.updateProfile(old.id, { displayName: "Existing Profile", schoolName: "School", gradeLevel: "1" });
    const response = await login(app.assertion());
    expect(response.status).toBe(302);
    expect(response.headers.location?.[0]).toBe("/dashboard");
    const cookie = response.headers["set-cookie"]?.[0].split(";", 1)[0] ?? "";
    const me = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/me`), { headers: { cookie } });
    expect(JSON.parse(me.bodyText).user.email).toBe("student@example.test");
    expect(users.findByEmail("student@example.test").map((user) => user.id)).toEqual([old.id]);
    expect(users.findByGoogleSubject("old-google-subject")?.id).toBe(old.id);
  });

  it("rejects empty or malformed email claims with 401 and no session", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    for (const email of ["", "  ", "not-an-email", "x@y", "x@y..test"]) {
      const response = await login(app.assertion({ email }));
      expect(response.status, email).toBe(401);
      expect(JSON.parse(response.bodyText)).toEqual({ error: "ACCESS_ASSERTION_INVALID" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it.each(["student@example.test", "STUDENT@EXAMPLE.TEST"])("rejects a second legacy user with email %s", async (secondEmail) => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const users = createRepositories(app.runtime.dbHandle.db).studentUsers;
    users.create({ googleSubject: "google-1", email: "student@example.test", displayName: "One" });
    users.create({ googleSubject: "google-2", email: secondEmail, displayName: "Two" });
    const response = await login(app.assertion());
    expect(response.status).toBe(403);
    expect(JSON.parse(response.bodyText)).toEqual({ error: "ACCESS_EMAIL_CONFLICT" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(users.findByEmail("student@example.test")).toHaveLength(2);
  });

  it("concurrent Access logins create one normalized account with separate sessions", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const token = app.assertion({ email: " New@Example.Test " });
    const responses = await Promise.all(Array.from({ length: 12 }, () => login(token)));
    expect(responses.every((response) => response.status === 302)).toBe(true);
    expect(new Set(responses.map((response) => response.headers["set-cookie"]?.[0].split(";", 1)[0])).size).toBe(12);
    const users = createRepositories(app.runtime.dbHandle.db).studentUsers;
    const matches = users.findByEmail("new@example.test");
    expect(matches).toHaveLength(1);
    expect(matches[0].email).toBe("new@example.test");
  });
});


describe("student passcode login", () => {
  it("issues, signs in, syncs history and revokes on disable and reset", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, secureCookies: false, mountTestAdmin: true });
    const url = (path: string) => new URL(`${app!.baseUrl}${path}`);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => rawHttpRequest(url(path), {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
    });
    const admin = { authorization: "Bearer test-only-admin-token" };
    expect((await post("/api/student/auth/passcode/login", { email: "a@example.test", passcode: "wrong" })).status).toBe(404);
    app.config.passcodeLoginEnabled = true;
    const issued = await post("/api/admin/student-passcodes", { email: "A@example.test" }, admin);
    expect(issued.status).toBe(201);
    const code = JSON.parse(issued.bodyText).passcode;
    const list = await rawHttpRequest(url("/api/admin/student-passcodes"), { headers: admin });
    expect(list.bodyText).not.toContain(code);
    expect(list.bodyText).not.toContain("passcodeHash");
    const row = JSON.parse(list.bodyText).passcodes[0];
    const signed = await post("/api/student/auth/passcode/login", { email: "a@example.test", passcode: code });
    expect(signed.status).toBe(200);
    const cookie = signed.headers["set-cookie"]![0].split(";", 1)[0];
    const me = await rawHttpRequest(url("/api/student/auth/me"), { headers: { cookie } });
    expect(JSON.parse(me.bodyText).authenticated).toBe(true);
    const profile = await rawHttpRequest(url("/api/student/auth/profile"), { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Test", schoolName: "School", gradeLevel: "1" }) });
    expect(profile.status).toBe(200);
    const history = await post("/api/student/learning-history", { entries: [{ id: "passcode-entry", askedAt: "2026-10-16T10:24:00.000Z", question: "hello", category: "auto", sourceType: "manual", strategy: "google-ai", syncVersion: 1 }] }, { cookie, origin: "https://student.example.test" });
    expect(history.status).toBe(200);
    const adminHistory = await rawHttpRequest(url("/api/admin/learning-history"), { headers: admin });
    expect(adminHistory.bodyText).toContain("passcode-entry");
    const disabled = await rawHttpRequest(url(`/api/admin/student-passcodes/${row.id}/status`), { method: "PATCH", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ status: "disabled" }) });
    expect(disabled.status).toBe(200);
    expect(JSON.parse((await rawHttpRequest(url("/api/student/auth/me"), { headers: { cookie } })).bodyText).authenticated).toBe(false);
    expect((await post("/api/student/auth/passcode/login", { email: row.email, passcode: code })).status).toBe(401);
    await rawHttpRequest(url(`/api/admin/student-passcodes/${row.id}/status`), { method: "PATCH", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) });
    const reset = await post(`/api/admin/student-passcodes/${row.id}/reset`, {}, admin);
    expect(reset.status).toBe(200);
    expect((await post("/api/student/auth/passcode/login", { email: row.email, passcode: code })).status).toBe(401);
    expect((await post("/api/student/auth/passcode/login", { email: row.email, passcode: JSON.parse(reset.bodyText).passcode })).status).toBe(200);
  });
});

it("returns 429 for the sixth email attempt and eleventh IP attempt", async () => {
  app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
  app.config.passcodeLoginEnabled = true;
  const attempt = (email: string) => rawHttpRequest(new URL(`${app!.baseUrl}/api/student/auth/passcode/login`), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, passcode: "bad" })
  });
  for (let i = 0; i < 5; i++) expect((await attempt("one@example.test")).status).toBe(401);
  const sixth = await attempt("one@example.test");
  expect(sixth.status).toBe(429);
  expect(Number(sixth.headers["retry-after"]?.[0])).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) expect((await attempt(`${i}@example.test`)).status).toBe(401);
  expect((await attempt("last@example.test")).status).toBe(429);
});


describe("passcode transaction across SQLite connections", () => {
  it.each(["disable", "reset"] as const)("rejects login if %s occurs after verification", async (action) => {
    let update = () => {};
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000, beforePasscodeCommit: () => update() });
    app.config.passcodeLoginEnabled = true;
    const other = createDbHandle(app.runtime.dbHandle.sqlite.name);
    try {
      const repos = createRepositories(other.db);
      const row = repos.studentPasscodes.create({ email: "race@example.test", passcodeHash: hashStudentPasscode("ABCDE-FGHJK") });
      update = () => { repos.studentPasscodes.changeAndRevoke(row.id, action === "disable" ? { status: "disabled" } : { passcodeHash: hashStudentPasscode("ZZZZZ-ZZZZZ") }); };
      const response = await rawHttpRequest(new URL(`${app.baseUrl}/api/student/auth/passcode/login`), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, passcode: "ABCDE-FGHJK" })
      });
      expect(response.status).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(other.sqlite.prepare("SELECT COUNT(*) AS count FROM student_sessions WHERE revoked_at IS NULL").get()).toEqual({ count: 0 });
    } finally { other.sqlite.close(); }
  });
  it.each(["disable", "reset"] as const)("%s revokes every session across users sharing the same normalized email", async (action) => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const repos = createRepositories(app.runtime.dbHandle.db);
    const row = repos.studentPasscodes.create({ email: "multi@example.test", passcodeHash: hashStudentPasscode("ABCDE-FGHJK") });
    const user1 = repos.studentUsers.create({ googleSubject: "one", email: "multi@example.test", displayName: "one" });
    const user2 = repos.studentUsers.create({ googleSubject: "two", email: " MULTI@EXAMPLE.TEST ", displayName: "two" });
    for (const [index, user] of [user1, user1, user2].entries()) repos.studentSessions.create({ tokenDigest: `digest-${index}`, userId: user.id, expiresAt: "2099-01-01T00:00:00.000Z" });
    repos.studentPasscodes.changeAndRevoke(row.id, action === "disable" ? { status: "disabled" } : { passcodeHash: hashStudentPasscode("ZZZZZ-ZZZZZ") });
    for (let index = 0; index < 3; index++) expect(repos.studentSessions.findActiveByTokenDigest(`digest-${index}`)).toBeUndefined();
  });
});
