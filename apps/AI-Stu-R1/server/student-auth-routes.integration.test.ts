import { afterEach, describe, expect, it } from "vitest";
import { rawHttpRequest, startStudentTestApp, type StudentTestApp } from "./testApp";
import { createRepositories } from "../../../packages/db/src";

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
