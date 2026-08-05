import { describe, expect, it } from "vitest";
import {
  StudentAuthService,
  buildGoogleAuthorizationUrl,
  createPkceChallenge,
  digestStudentSecret,
  studentSessionCookieOptions,
  type StudentAuthConfig,
  type StudentAuthRepositories,
  type StudentAuthUserRecord,
  type GoogleIdentity
} from "../src/server";

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
    stats: { userCreates: () => userCreates, sessionCreates: () => sessionCreates }
  };
}

describe("Student Auth Foundation", () => {
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
});
