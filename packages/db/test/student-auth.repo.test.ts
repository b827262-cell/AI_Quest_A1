import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDbHandle, createRepositories, runMigrations } from "../src";

describe("Student Auth repositories", () => {
  it("persists users, one-time OAuth state, expiry and revocation without raw tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-quest-student-auth-"));
    const handle = createDbHandle(join(directory, "auth.sqlite"));
    try {
      runMigrations(handle.sqlite);
      const repos = createRepositories(handle.db);
      const user = repos.studentUsers.create({ googleSubject: "google-subject", email: "s@example.test", displayName: "Student" });
      const session = repos.studentSessions.create({ tokenDigest: "digest-only", userId: user.id, expiresAt: "2999-01-01T00:00:00.000Z" });
      expect(repos.studentSessions.findActiveByTokenDigest("digest-only")?.userId).toBe(user.id);
      expect(handle.sqlite.prepare("SELECT token_digest FROM student_sessions WHERE id = ?").get(session.id)).toEqual({ token_digest: "digest-only" });
      expect(repos.studentSessions.revokeById(session.id)).toBe(true);
      expect(repos.studentSessions.findActiveByTokenDigest("digest-only")).toBeUndefined();
      repos.studentOAuthStates.create({ stateDigest: "state-digest", verifierCiphertext: "encrypted-verifier", returnTo: "/books", expiresAt: "2999-01-01T00:00:00.000Z" });
      expect(repos.studentOAuthStates.consume("state-digest")?.returnTo).toBe("/books");
      expect(repos.studentOAuthStates.consume("state-digest")).toBeUndefined();
    } finally {
      handle.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
