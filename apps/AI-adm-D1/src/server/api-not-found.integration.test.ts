import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createDbHandle } from "@ai-smartbook/db";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";

const origin = "http://127.0.0.1:5174";
const directories: string[] = [];
const handles: Array<ReturnType<typeof createDbHandle>> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.sqlite.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function app() {
  const directory = mkdtempSync(join(tmpdir(), "a01-api-404-"));
  directories.push(directory);
  const handle = createDbHandle(join(directory, "test.sqlite"));
  handles.push(handle);
  const env = {
    NODE_ENV: "test",
    ADMIN_API_TOKEN: "test-admin-token",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password",
    ADMIN_ALLOWED_ORIGINS: origin,
    STUDENT_ALLOWED_ORIGINS: origin,
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    AI_CREDENTIAL_ENCRYPTION_KEY: "test-only-encryption-key-0123456789",
    STUDENT_SESSION_SECRET: "test-only-student-session-secret-0123456789"
  };
  return createAdminApp(createAdminTestDependencies(env, handle));
}

describe("unknown /api/* answers JSON 404 (admin server)", () => {
  it("returns a structured JSON 404 for an unknown GET", async () => {
    const response = await request(app()).get("/api/definitely-not-a-route");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.body).toEqual({ error: "NOT_FOUND" });
    // No Express default page, stack trace or source reference may leak.
    expect(response.text).not.toMatch(/Cannot GET|<html|at .*\.ts:/i);
  });

  it("returns a structured JSON 404 for an unknown POST", async () => {
    const response = await request(app()).post("/api/definitely-not-a-route").send({ anything: true });
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.body).toEqual({ error: "NOT_FOUND" });
  });

  it("still answers malformed JSON with 400 INVALID_JSON", async () => {
    const response = await request(app())
      .post("/api/definitely-not-a-route")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "INVALID_JSON" });
  });

  it("leaves non-API 404s on the default HTML page", async () => {
    const response = await request(app()).get("/definitely-not-a-page");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
  });

  it("keeps real routes working", async () => {
    const response = await request(app()).get("/health/live");
    expect(response.status).toBe(200);
  });
});
