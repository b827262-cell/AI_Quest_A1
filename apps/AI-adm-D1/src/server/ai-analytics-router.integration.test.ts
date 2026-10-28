import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createDbHandle } from "@ai-smartbook/db";
import { createStudentSessionSecrets, digestStudentSecret } from "@ai-smartbook/auth/server";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";

const originalEnv = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AI analytics HTTP routes", () => {
  it("enforces the admin boundary and preserves responses and validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "analytics-routes-"));
    dirs.push(dir);
    const db = createDbHandle(join(dir, "test.sqlite"));
    process.env = { ...process.env, NODE_ENV: "test", ADMIN_API_TOKEN: "analytics-test-token",
      ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174", AI_PROVIDER: "mock", AI_GATEWAY_ENABLED: "false",
      AI_CREDENTIAL_ENCRYPTION_KEY: "test-encryption-key-0123456789", SQLITE_PATH: join(dir, "test.sqlite") };
    const deps = createAdminTestDependencies(process.env, db);
    const app = createAdminApp(deps);
    const student = deps.repos.studentUsers.create({ googleSubject: "analytics-student", email: "analytics@example.test", displayName: "Student" });
    const { sessionToken } = createStudentSessionSecrets();
    deps.repos.studentSessions.create({ tokenDigest: digestStudentSecret(sessionToken), userId: student.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    deps.repos.aiRequestLogs.create({ requestId: "fixture", requestSource: "student", question: "test", subject: "math",
      taskType: "question_answering", complexity: "low", routingProvider: "mock", routingReason: "test", providerAttempts: [], status: "success", latencyMs: 1 });
    deps.repos.aiUsageLogs.create({ requestId: "fixture", provider: "mock", model: "fixture", inputCostMicrousd: 0, cachedInputCostMicrousd: 0, outputCostMicrousd: 0, totalCostMicrousd: 0, estimatedCostMicroUsd: 0, actualCostMicroUsd: 0 });
    const paths = ["/api/admin/ai-analytics/summary", "/api/admin/ai-analytics/daily", "/api/admin/ai-analytics/providers",
      "/api/admin/ai-analytics/subjects", "/api/admin/ai-requests", "/api/admin/ai-requests/fixture", "/api/admin/ai-usage/fixture"];
    for (const path of paths) {
      expect((await request(app).get(path)).status, path).toBe(401);
      expect((await request(app).get(path).set("Cookie", `ai_student_session=${sessionToken}`)).status, path).toBe(401);
      expect((await request(app).get(path).set("x-admin-token", "analytics-test-token").set("Origin", "https://evil.example")).status, path).toBe(403);
      expect((await request(app).get(path).set("x-admin-token", "analytics-test-token")).status, path).toBe(200);
    }
    for (const [path, message] of [
      ["/api/admin/ai-analytics/summary?date=bad", "date must be a valid YYYY-MM-DD date"],
      ["/api/admin/ai-requests?page=0", "page must be a positive integer"],
      ["/api/admin/ai-requests?limit=201", "limit must be an integer between 1 and 200"],
      ["/api/admin/ai-requests?sort=bad", "sort is not supported"],
      ["/api/admin/ai-requests?provider=bad", "provider is not supported"]
    ]) {
      const response = await request(app).get(path).set("x-admin-token", "analytics-test-token");
      expect(response.status, path).toBe(400);
      expect(response.body.error).toBe(message);
    }
    for (const [path, message] of [["/api/admin/ai-requests/missing", "request not found"], ["/api/admin/ai-usage/missing", "usage not found"]]) {
      const response = await request(app).get(path).set("x-admin-token", "analytics-test-token");
      expect(response.status, path).toBe(404);
      expect(response.body.error).toBe(message);
    }
    db.sqlite.close();
  });
});
