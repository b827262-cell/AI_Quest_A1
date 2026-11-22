import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
  assertStudentAuthConfig,
  createStudentAuthService,
  isAllowedStudentMutatingOrigin,
  resolveStudentAuthConfig,
  type StudentAuthConfig,
  type StudentAuthRepositories,
  type StudentAuthUserRecord
} from "../src/server";
import { createStudentAuthRouter, createStudentLearningHistoryRouter } from "../src/express";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function baseConfig(overrides: Partial<StudentAuthConfig> = {}): StudentAuthConfig {
  return {
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
    allowedOrigins: new Set<string>(),
    googleAuthorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    googleTokenEndpoint: "https://oauth2.googleapis.com/token",
    googleUserinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    accessTeamDomain: "team",
    accessAud: "aud",
    accessCertsUrl: "http://127.0.0.1/certs",
    ...overrides
  };
}

function buildService(config: StudentAuthConfig) {
  const users = new Map<string, StudentAuthUserRecord>();
  const repositories: StudentAuthRepositories = {
    users: {
      findByGoogleSubject: () => undefined,
      findByEmail: () => [],
      create: (input) => {
        const user: StudentAuthUserRecord = {
          id: "u1",
          email: input.email,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? null,
          schoolName: null,
          gradeLevel: null,
          profileCompleted: false
        };
        users.set(user.id, user);
        return user;
      },
      updateGoogleLogin: (id) => users.get(id)!,
      updateProfile: (id, input) => ({ ...users.get(id)!, ...input, profileCompleted: true }),
      findById: (id) => users.get(id)
    },
    sessions: {
      create: (input) => ({ id: "s1", userId: input.userId, expiresAt: input.expiresAt }),
      findActiveByTokenDigest: () => undefined,
      revokeById: () => false,
      revokeByTokenDigest: () => false,
      purgeExpired: () => 0
    },
    oauthStates: {
      create: () => {},
      consume: () => undefined,
      purgeExpired: () => 0
    }
  };
  return createStudentAuthService(config, repositories);
}

function learningHistoryRepo() {
  return {
    listStudent: () => [],
    upsertBatch: (_studentId: string, entries: unknown[]) => entries,
    tombstone: () => undefined
  } as never;
}

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${address.port}`;
}

describe("student mutating origin policy", () => {
  it("fails closed for empty allowlist, missing origin, and cross-origin requests", () => {
    const config = baseConfig({ allowedOrigins: new Set() });
    expect(isAllowedStudentMutatingOrigin(config, { origin: undefined, host: "127.0.0.1:4310" })).toBe(false);
    expect(isAllowedStudentMutatingOrigin(config, { origin: "https://evil.example", host: "127.0.0.1:4310", secFetchSite: "cross-site" })).toBe(false);
  });

  it("allows same-origin requests without an allowlist entry", () => {
    const config = baseConfig({ allowedOrigins: new Set() });
    expect(isAllowedStudentMutatingOrigin(config, {
      origin: "http://127.0.0.1:4310",
      host: "127.0.0.1:4310",
      secFetchSite: "same-origin"
    })).toBe(true);
  });

  it("allows explicitly allowlisted cross-origin requests and rejects other cross-origin requests", () => {
    const config = baseConfig({ allowedOrigins: new Set(["https://student.example.test"]) });
    expect(isAllowedStudentMutatingOrigin(config, {
      origin: "https://student.example.test",
      host: "api.example.test",
      secFetchSite: "cross-site"
    })).toBe(true);
    expect(isAllowedStudentMutatingOrigin(config, {
      origin: "https://other.example.test",
      host: "api.example.test",
      secFetchSite: "cross-site"
    })).toBe(false);
  });

  it("requires a non-empty STUDENT_ALLOWED_ORIGINS in production", () => {
    const config = resolveStudentAuthConfig({
      NODE_ENV: "production",
      STUDENT_SESSION_SECRET: "a-secret-that-is-longer-than-thirty-two-characters",
      STUDENT_ACCESS_TEAM_DOMAIN: "team",
      STUDENT_ACCESS_AUD: "aud",
      STUDENT_ALLOWED_ORIGINS: ""
    });
    expect(config.allowedOrigins.size).toBe(0);
    expect(() => assertStudentAuthConfig(config)).toThrow(
      "production Student auth requires STUDENT_ALLOWED_ORIGINS to include at least one allowed origin"
    );

    const ok = resolveStudentAuthConfig({
      NODE_ENV: "production",
      STUDENT_SESSION_SECRET: "a-secret-that-is-longer-than-thirty-two-characters",
      STUDENT_ACCESS_TEAM_DOMAIN: "team",
      STUDENT_ACCESS_AUD: "aud",
      STUDENT_ALLOWED_ORIGINS: "https://student.example.test, https://admin.example.test"
    });
    expect([...ok.allowedOrigins]).toEqual(["https://student.example.test", "https://admin.example.test"]);
    expect(() => assertStudentAuthConfig(ok)).not.toThrow();
  });
});

describe("student HTTP origin enforcement", () => {
  it("applies the same policy to auth mutating routes and learning-history routes", async () => {
    const empty = baseConfig({ allowedOrigins: new Set() });
    const allowlisted = baseConfig({ allowedOrigins: new Set(["https://student.example.test"]) });

    for (const config of [empty, allowlisted]) {
      const app = express();
      app.use(express.json());
      app.use("/api/student/auth", createStudentAuthRouter(buildService(config), config));
      app.use("/api/student", createStudentLearningHistoryRouter(learningHistoryRepo(), config));
      const baseUrl = await listen(app);
      const sameOrigin = new URL(baseUrl).origin;

      const crossLogout = await fetch(`${baseUrl}/api/student/auth/logout`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site"
        }
      });
      expect(crossLogout.status).toBe(403);
      expect(await crossLogout.json()).toEqual({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });

      const missingOriginLogout = await fetch(`${baseUrl}/api/student/auth/logout`, {
        method: "POST",
        headers: {}
      });
      expect(missingOriginLogout.status).toBe(403);

      const crossHistory = await fetch(`${baseUrl}/api/student/learning-history`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json"
        },
        body: JSON.stringify({ entries: [] })
      });
      expect(crossHistory.status).toBe(403);
      expect(await crossHistory.json()).toEqual({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });

      const sameOriginLogout = await fetch(`${baseUrl}/api/student/auth/logout`, {
        method: "POST",
        headers: {
          origin: sameOrigin,
          "sec-fetch-site": "same-origin"
        }
      });
      expect(sameOriginLogout.status).toBe(204);

      const sameOriginHistory = await fetch(`${baseUrl}/api/student/learning-history`, {
        method: "POST",
        headers: {
          origin: sameOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json"
        },
        body: JSON.stringify({ entries: [] })
      });
      expect(sameOriginHistory.status).not.toBe(403);
    }

    const app = express();
    app.use(express.json());
    app.use("/api/student/auth", createStudentAuthRouter(buildService(allowlisted), allowlisted));
    app.use("/api/student", createStudentLearningHistoryRouter(learningHistoryRepo(), allowlisted));
    const baseUrl = await listen(app);

    const allowedLogout = await fetch(`${baseUrl}/api/student/auth/logout`, {
      method: "POST",
      headers: {
        origin: "https://student.example.test",
        "sec-fetch-site": "cross-site"
      }
    });
    expect(allowedLogout.status).toBe(204);

    const disallowedLogout = await fetch(`${baseUrl}/api/student/auth/logout`, {
      method: "POST",
      headers: {
        origin: "https://other.example.test",
        "sec-fetch-site": "cross-site"
      }
    });
    expect(disallowedLogout.status).toBe(403);
  });
});
