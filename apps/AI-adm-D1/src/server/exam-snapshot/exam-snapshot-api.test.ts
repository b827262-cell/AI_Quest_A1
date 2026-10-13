import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApp } from "../app";
import { createAdminTestDependencies } from "../dependencies";
import { createDbHandle } from "@ai-smartbook/db";

const temporaryDirectories: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A-01 Slot D endpoint contract, exercised through the real admin app so the
 * mount, the `/api/admin` auth boundary and the fail-safe behaviour are all
 * covered by the same request that an operator makes.
 *
 * No `DATABASE_URL` is ever present here, which is the point: the endpoints must
 * answer with an explicit failure instead of reaching for the network or claiming
 * a refresh happened.
 */
function buildApp() {
  const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-exam-snapshot-"));
  temporaryDirectories.push(directory);
  const token = "slot-d-test-token";
  const env: NodeJS.ProcessEnv = {
    ...originalEnv,
    NODE_ENV: "test",
    ADMIN_API_TOKEN: token,
    AI_CREDENTIAL_ENCRYPTION_KEY: "slot-d-test-encryption-key-0123456789",
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    SQLITE_PATH: join(directory, "admin.db")
  };
  delete env.DATABASE_URL;
  delete env.ADMIN_PASSWORD_HASH;
  process.env = { ...env };
  const dbHandle = createDbHandle(join(directory, "admin.db"));
  return { app: createAdminApp(createAdminTestDependencies(env, dbHandle)), token };
}

describe("GET/POST /api/admin/exam-snapshots", () => {
  it("requires admin authentication", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .get("/api/admin/exam-snapshots")
      .set("Origin", "http://127.0.0.1:5174");
    expect(response.status).toBe(401);
  });

  it("lists 115/116 and states plainly that the database is not configured", async () => {
    const { app, token } = buildApp();
    const response = await request(app)
      .get("/api/admin/exam-snapshots")
      .set("Origin", "http://127.0.0.1:5174")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data_source).toBe("unavailable");
    expect(response.body.snapshots.map((row: { year: string }) => row.year)).toEqual(["115", "116"]);
    for (const row of response.body.snapshots) {
      expect(row).toMatchObject({ status: "unavailable", last_error: "database_not_configured" });
      expect(row.row_count).toBeNull();
      expect(row.last_snapshot_at).toBeNull();
    }
  });

  it("refuses a year outside 115/116 without pretending to refresh", async () => {
    const { app, token } = buildApp();
    const response = await request(app)
      .post("/api/admin/exam-snapshots/117/refresh-today")
      .set("Origin", "http://127.0.0.1:5174")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "exam-snapshot-117-2026-10-04")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      year: "117",
      status: "failed",
      changed_count: 0,
      error_count: 1,
      fetched_at: null,
      code: "invalid_exam_year"
    });
  });

  it("requires an idempotency key for a write", async () => {
    const { app, token } = buildApp();
    const response = await request(app)
      .post("/api/admin/exam-snapshots/115/refresh-today")
      .set("Origin", "http://127.0.0.1:5174")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("missing_idempotency_key");
  });

  it("answers 503 with zero writes when no database target is configured", async () => {
    const { app, token } = buildApp();
    const response = await request(app)
      .post("/api/admin/exam-snapshots/115/refresh-today")
      .set("Origin", "http://127.0.0.1:5174")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "exam-snapshot-115-2026-10-04")
      .send({});

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      year: "115",
      status: "failed",
      changed_count: 0,
      error_count: 1,
      fetched_at: null,
      code: "database_not_configured"
    });
    expect(response.body.snapshot).toMatchObject({ year: "115", last_error: "database_not_configured" });
  });
});
