import { describe, expect, it, vi } from "vitest";
import {
  StudentAuthService,
  buildGoogleAuthorizationUrl,
  createPkceChallenge,
  digestStudentSecret,
  assertStudentAuthConfig,
  resolveStudentAuthConfig,
  studentSessionCookieOptions,
  type StudentAuthConfig,
  type StudentAuthRepositories,
  type StudentAuthUserRecord,
  type GoogleIdentity
} from "../src/server";
import { safeStudentReturnTo } from "../src/shared";
import { startFakeAccessCerts } from "../../../scripts/student-access-fixture";
import { AccessInvalidTokenError, AccessUnavailableError, verifyAccessAssertion } from "../src/access";

function buildFakeAuth(now: () => number, exchangeIdentity: (code: string, verifier: string) => Promise<GoogleIdentity>) {
  const users = new Map<string, StudentAuthUserRecord>();
  const subjects = new Map<string, string>();
  const sessions = new Map<string, { id: string; userId: string; expiresAt: string; revokedAt?: string; lastSeenAt: string }>();
  const states = new Map<string, { verifierCiphertext: string; returnTo: string; expiresAt: string; consumedAt?: string }>();
  let userCreates = 0;
  let sessionCreates = 0;
  const repositories: StudentAuthRepositories = {
    users: {
      findByGoogleSubject(subject) {
        const id = subjects.get(subject);
        return id ? users.get(id) : undefined;
      },
      findByEmail(email) {
        return [...users.values()].filter((user) => user.email.trim().toLowerCase() === email.trim().toLowerCase());
      },
      create(input) {
        const user: StudentAuthUserRecord = {
          id: `user-${++userCreates}`,
          email: input.email,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? null,
          schoolName: null,
          gradeLevel: null,
          profileCompleted: false
        };
        users.set(user.id, user);
        subjects.set(input.googleSubject, user.id);
        return user;
      },
      updateGoogleLogin(id, input) {
        const user = users.get(id)!;
        if (!user.profileCompleted) user.displayName = input.displayName;
        user.email = input.email;
        user.avatarUrl = input.avatarUrl ?? null;
        return user;
      },
      updateProfile(id, input) {
        const user = users.get(id)!;
        Object.assign(user, input, { profileCompleted: true });
        return user;
      },
      findById(id) {
        return users.get(id);
      }
    },
    sessions: {
      create(input) {
        const session = { id: `session-${++sessionCreates}`, userId: input.userId, expiresAt: input.expiresAt, revokedAt: undefined, lastSeenAt: new Date(now()).toISOString() };
        sessions.set(input.tokenDigest, session);
        return session;
      },
      findActiveByTokenDigest(tokenDigest, current = new Date(now()).toISOString()) {
        const session = sessions.get(tokenDigest);
        if (!session || session.revokedAt || session.expiresAt <= current) return undefined;
        session.lastSeenAt = current;
        return session;
      },
      revokeById(id, at = new Date(now()).toISOString()) {
        const session = [...sessions.values()].find((candidate) => candidate.id === id);
        if (!session || session.revokedAt) return false;
        session.revokedAt = at;
        return true;
      },
      revokeByTokenDigest(tokenDigest, at = new Date(now()).toISOString()) {
        const session = sessions.get(tokenDigest);
        if (!session || session.revokedAt) return false;
        session.revokedAt = at;
        return true;
      },
      purgeExpired() {
        return 0;
      }
    },
    oauthStates: {
      create(input) {
        states.set(input.stateDigest, { verifierCiphertext: input.verifierCiphertext, returnTo: input.returnTo, expiresAt: input.expiresAt });
      },
      consume(stateDigest, current = new Date(now()).toISOString()) {
        const state = states.get(stateDigest);
        if (!state || state.consumedAt || state.expiresAt <= current) return undefined;
        state.consumedAt = current;
        return { verifierCiphertext: state.verifierCiphertext, returnTo: state.returnTo };
      },
      purgeExpired() {
        return 0;
      }
    }
  };
  const config: StudentAuthConfig = {
    production: false,
    enabled: true,
    googleClientId: "client-id",
    googleClientSecret: "provider-secret",
    googleRedirectUri: "https://student.example.test/api/student/auth/google/callback",
    sessionSecret: "a-session-secret-that-is-long-enough-for-tests",
    sessionTtlMs: 60_000,
    oauthStateTtlMs: 60_000,
    sessionCookie: "ai_student_session",
    secureCookies: true,
    allowedOrigins: new Set(["https://student.example.test"]),
    googleAuthorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    googleTokenEndpoint: "https://oauth2.googleapis.com/token",
    googleUserinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo"
  };
  return {
    service: new StudentAuthService(config, repositories, now, exchangeIdentity),
    config,
    repositories,
    stats: { userCreates: () => userCreates, sessionCreates: () => sessionCreates }
  };
}

describe("Student Auth Foundation", () => {
  it("rejects insecure session cookies in production", () => {
    const config = resolveStudentAuthConfig({ NODE_ENV: "production", STUDENT_SESSION_SECURE: "false" });
    expect(config.secureCookies).toBe(false);
    expect(() => assertStudentAuthConfig(config)).toThrow("production Student auth requires STUDENT_SESSION_SECURE=true");
  });

  it("keeps Secure enabled by default", () => {
    const config = resolveStudentAuthConfig({ NODE_ENV: "development" });
    expect(studentSessionCookieOptions(config).secure).toBe(true);
  });

  it("accepts a signed Access email, reuses the existing Google user, and keeps the same session path", async () => {
    const certs = await startFakeAccessCerts();
    try {
      const { service, config, stats } = buildFakeAuth(Date.now, async () => ({ subject: "old-google", email: "student@example.test", displayName: "Old Google", avatarUrl: null }));
      config.accessTeamDomain = certs.teamDomain;
      config.accessAud = certs.aud;
      config.accessCertsUrl = certs.certsUrl;
      const googleStart = service.beginGoogleLogin();
      const state = new URL(googleStart.authorizationUrl).searchParams.get("state")!;
      const old = await service.completeGoogleLogin({ state, code: "code" });
      const result = await service.completeAccessLogin({ assertion: certs.assertion({ email: " Student@Example.Test " }), returnTo: "//attacker.example" });
      expect(result.user.id).toBe(old.user.id);
      expect(result.returnTo).toBe("/books");
      expect(stats.userCreates()).toBe(1);
      expect(service.restoreSession(result.sessionToken)?.user.email).toBe("student@example.test");
      await expect(service.completeAccessLogin({ assertion: undefined })).rejects.toThrow();
    } finally { await certs.close(); }
  });

  it("rejects empty and malformed verified emails before creating a session", async () => {
    const certs = await startFakeAccessCerts();
    try {
      const { service, config, stats } = buildFakeAuth(Date.now, async () => ({ subject: "unused", email: "unused@example.test", displayName: "Unused", avatarUrl: null }));
      Object.assign(config, { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl });
      for (const email of ["", "   ", "not-an-email", "a@b", "a@b.", "a@b..test"]) {
        await expect(service.completeAccessLogin({ assertion: certs.assertion({ email }) })).rejects.toThrow("invalid email");
      }
      expect(stats.userCreates()).toBe(0);
      expect(stats.sessionCreates()).toBe(0);
    } finally { await certs.close(); }
  });

  it("reuses one user for concurrent logins and recovers a competing creator's unique-subject insert", async () => {
    const certs = await startFakeAccessCerts();
    try {
      const { service, config, repositories, stats } = buildFakeAuth(Date.now, async () => ({ subject: "unused", email: "unused@example.test", displayName: "Unused", avatarUrl: null }));
      Object.assign(config, { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl });
      const assertion = certs.assertion({ email: " NEW@Example.Test " });
      const results = await Promise.all(Array.from({ length: 12 }, () => service.completeAccessLogin({ assertion })));
      expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
      expect(stats.userCreates()).toBe(1);
      expect(stats.sessionCreates()).toBe(12);

      const originalCreate = repositories.users.create;
      repositories.users.create = (input) => {
        originalCreate(input); // Simulate the other process winning the insert.
        throw new Error("UNIQUE constraint failed: student_users.google_subject");
      };
      const raced = await service.completeAccessLogin({ assertion: certs.assertion({ email: "race@example.test" }) });
      expect(raced.user.email).toBe("race@example.test");
      expect(stats.userCreates()).toBe(2);
    } finally { await certs.close(); }
  });

  it("rejects duplicate normalized email matches and logs only a digest and count", async () => {
    const certs = await startFakeAccessCerts();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, config, repositories, stats } = buildFakeAuth(Date.now, async () => ({ subject: "unused", email: "unused@example.test", displayName: "Unused", avatarUrl: null }));
      Object.assign(config, { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl });
      repositories.users.create({ googleSubject: "google-1", email: "Student@Example.Test", displayName: "One" });
      repositories.users.create({ googleSubject: "google-2", email: " student@example.test ", displayName: "Two" });
      const assertion = certs.assertion({ email: "student@example.test" });
      await expect(service.completeAccessLogin({ assertion })).rejects.toThrow("multiple student users");
      expect(stats.sessionCreates()).toBe(0);
      expect(warning).toHaveBeenCalledWith("STUDENT_ACCESS_EMAIL_CONFLICT", {
        emailSha256: digestStudentSecret("student@example.test"), matchCount: 2
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(assertion);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("student@example.test");
    } finally { warning.mockRestore(); await certs.close(); }
  });

  it("revalidates reused assertions against signature, audience, issuer and time on every use", async () => {
    const certs = await startFakeAccessCerts();
    try {
      const now = Math.floor(Date.now() / 1000);
      const config = { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl };
      const token = certs.assertion({ iat: now, nbf: now, exp: now + 120 });
      expect(await verifyAccessAssertion(token, config, now * 1000)).toBe("student@example.test");
      expect(await verifyAccessAssertion(token, config, now * 1000)).toBe("student@example.test");
      await expect(verifyAccessAssertion(token, { ...config, accessAud: "other" }, now * 1000)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      await expect(verifyAccessAssertion(token, { ...config, accessTeamDomain: "other" }, now * 1000)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      await expect(verifyAccessAssertion(token, config, (now + 181) * 1000)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      await expect(verifyAccessAssertion(token, config, (now - 61) * 1000)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      const parts = token.split(".");
      const altered = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(verifyAccessAssertion(altered, config, now * 1000)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      }
    } finally { await certs.close(); }
  });

  it("ignores a fixture certs URL in production while permitting it in tests", () => {
    const env = { STUDENT_ACCESS_CERTS_URL: "http://127.0.0.1:9999/certs", STUDENT_ACCESS_TEAM_DOMAIN: "team", STUDENT_ACCESS_AUD: "aud", STUDENT_SESSION_SECRET: "a-secret-that-is-longer-than-thirty-two-characters" };
    const production = resolveStudentAuthConfig({ ...env, NODE_ENV: "production" });
    expect(production.accessCertsUrl).toBeUndefined();
    expect(() => assertStudentAuthConfig(production)).not.toThrow();
    expect(resolveStudentAuthConfig({ ...env, NODE_ENV: "test" }).accessCertsUrl).toBe(env.STUDENT_ACCESS_CERTS_URL);
    expect(() => assertStudentAuthConfig({ ...production, accessCertsUrl: env.STUDENT_ACCESS_CERTS_URL })).toThrow();
  });

  it("requires Access config in production without Google client credentials", () => {
    const config = resolveStudentAuthConfig({ NODE_ENV: "production", STUDENT_SESSION_SECRET: "a-secret-that-is-longer-than-thirty-two-characters", STUDENT_ACCESS_TEAM_DOMAIN: "team", STUDENT_ACCESS_AUD: "aud" });
    expect(() => assertStudentAuthConfig(config)).not.toThrow();
    expect(() => assertStudentAuthConfig({ ...config, accessAud: undefined })).toThrow();
  });

  it("fails with service unavailable when Access config is absent", async () => {
    const { service } = buildFakeAuth(Date.now, async () => ({ subject: "unused", email: "unused@example.test", displayName: "Unused", avatarUrl: null }));
    await expect(service.completeAccessLogin({ assertion: "untrusted.jwt.value" })).rejects.toBeInstanceOf(AccessUnavailableError);
  });
  it("creates one user for repeated Google logins and keeps profile state server-side", async () => {
    let clock = Date.parse("2026-08-05T00:00:00.000Z");
    const identity = { subject: "google-subject-1", email: "student@example.test", displayName: "學員一號", avatarUrl: null };
    const { service, stats } = buildFakeAuth(() => clock, async () => identity);
    const firstStart = service.beginGoogleLogin("/books?next=1");
    const state = new URL(firstStart.authorizationUrl).searchParams.get("state")!;
    const first = await service.completeGoogleLogin({ state, code: "code-1" });
    const secondStart = service.beginGoogleLogin("https://evil.example/redirect");
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get("state")!;
    const second = await service.completeGoogleLogin({ state: secondState, code: "code-2" });
    expect(stats.userCreates()).toBe(1);
    expect(stats.sessionCreates()).toBe(2);
    expect(second.user.id).toBe(first.user.id);
    expect(first.profile.profileCompleted).toBe(false);
    expect(second.returnTo).toBe("/books");
    const completed = service.updateProfile(first.user.id, { displayName: "學員一號", schoolName: "測試大學", gradeLevel: "一年級" });
    expect(completed.profileCompleted).toBe(true);
    clock += 1_000;
    expect(service.restoreSession(first.sessionToken)?.user.id).toBe(first.user.id);
  });

  it("expires, revokes and rejects replayed sessions", async () => {
    let clock = Date.parse("2026-08-05T00:00:00.000Z");
    const { service } = buildFakeAuth(() => clock, async () => ({ subject: "sub", email: "s@example.test", displayName: "S", avatarUrl: null }));
    const start = service.beginGoogleLogin();
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const result = await service.completeGoogleLogin({ state, code: "code" });
    expect(service.restoreSession(result.sessionToken)).toBeTruthy();
    expect(service.revokeSession(result.sessionToken)).toBe(true);
    expect(service.restoreSession(result.sessionToken)).toBeUndefined();
    const secondStart = service.beginGoogleLogin();
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get("state")!;
    const second = await service.completeGoogleLogin({ state: secondState, code: "code-2" });
    clock += 61_000;
    expect(service.restoreSession(second.sessionToken)).toBeUndefined();
  });

  it("validates OAuth state once and keeps provider secrets out of browser exports", async () => {
    let clock = Date.parse("2026-08-05T00:00:00.000Z");
    const { service, config } = buildFakeAuth(() => clock, async () => ({ subject: "sub", email: "s@example.test", displayName: "S", avatarUrl: null }));
    await expect(service.completeGoogleLogin({ state: "wrong", code: "code" })).rejects.toThrow("oauth state is invalid");
    const verifier = "verifier";
    const url = buildGoogleAuthorizationUrl(config, "state", verifier);
    expect(url).toContain(`code_challenge=${encodeURIComponent(createPkceChallenge(verifier))}`);
    expect(url).not.toContain("provider-secret");
    expect(studentSessionCookieOptions(config)).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict" });
    expect(digestStudentSecret("raw-token")).not.toBe("raw-token");
    clock += 1;
  });

  it("uses one shared learning return contract and consumes cancelled OAuth transactions", async () => {
    let clock = Date.parse("2026-08-05T00:00:00.000Z");
    const { service, stats } = buildFakeAuth(() => clock, async () => ({ subject: "sub", email: "s@example.test", displayName: "S", avatarUrl: null }));
    expect(safeStudentReturnTo("/books/unit-1?tab=notes")).toBe("/books/unit-1?tab=notes");
    expect(safeStudentReturnTo("//attacker.example")).toBe("/books");
    expect(safeStudentReturnTo("/books\\attacker")).toBe("/books");
    expect(safeStudentReturnTo("/books\r\nLocation: https://attacker.example")).toBe("/books");

    const start = service.beginGoogleLogin("//attacker.example");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect(service.cancelOAuthLogin(state)).toEqual({ returnTo: "/books" });
    await expect(service.completeGoogleLogin({ state, code: "late-code" })).rejects.toThrow("oauth state is invalid");
    expect(stats.sessionCreates()).toBe(0);

    const expiredStart = service.beginGoogleLogin("/books");
    const expiredState = new URL(expiredStart.authorizationUrl).searchParams.get("state")!;
    clock += 61_000;
    expect(service.cancelOAuthLogin(expiredState)).toBeUndefined();
  });
});
