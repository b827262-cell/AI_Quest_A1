import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";
import { createDbHandle, type DbHandle } from "@ai-smartbook/db";

const temporaryDirectories: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function buildTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-books-availability-"));
  temporaryDirectories.push(directory);
  const dbHandle: DbHandle = createDbHandle(join(directory, "admin.db"));
  const token = "books-availability-test-token";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    ADMIN_API_TOKEN: token,
    AI_CREDENTIAL_ENCRYPTION_KEY: "phase-a-test-encryption-key-0123456789",
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password",
    ADMIN_SESSION_SECURE: "true"
  };
  process.env = { ...process.env, ...env, SQLITE_PATH: join(directory, "admin.db") };
  const dependencies = createAdminTestDependencies(process.env, dbHandle);
  return { app: createAdminApp(dependencies), dependencies, dbHandle, token };
}

function seedPublishedBook(dependencies: ReturnType<typeof createAdminTestDependencies>) {
  return dependencies.repos.books.create({
    title: "Books Availability Regression Fixture",
    status: "published"
  });
}

describe("Books availability control (booksPageEnabled)", () => {
  it("defaults to enabled: list and detail both serve the published book", async () => {
    const { app, dependencies, token } = buildTestApp();
    const book = seedPublishedBook(dependencies);

    const list = await request(app).get("/api/student/books");
    expect(list.status).toBe(200);
    expect(list.body.books.map((b: { id: string }) => b.id)).toContain(book.id);

    const detail = await request(app).get(`/api/student/books/${book.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.book.id).toBe(book.id);

    // sanity: the flag really does default true via the admin-facing config too
    const config = await request(app).get("/api/admin/site-config").set("x-admin-token", token);
    expect(config.status).toBe(200);
    expect(config.body.config.booksPageEnabled).toBe(true);
  });

  it("404s both list and detail once disabled, then recovers immediately without rebuild once re-enabled", async () => {
    const { app, dependencies, token } = buildTestApp();
    const book = seedPublishedBook(dependencies);

    const disable = await request(app)
      .put("/api/admin/site-config")
      .set("x-admin-token", token)
      .send({ booksPageEnabled: false });
    expect(disable.status).toBe(200);
    expect(disable.body.config.booksPageEnabled).toBe(false);

    const listDisabled = await request(app).get("/api/student/books");
    expect(listDisabled.status).toBe(404);
    expect(listDisabled.body.error).toBe("books page disabled");

    const detailDisabled = await request(app).get(`/api/student/books/${book.id}`);
    expect(detailDisabled.status).toBe(404);
    expect(detailDisabled.body.error).toBe("books page disabled");

    // an unknown bookId must not leak a different error/status while disabled
    const unknownDisabled = await request(app).get("/api/student/books/does-not-exist");
    expect(unknownDisabled.status).toBe(404);
    expect(unknownDisabled.body.error).toBe("books page disabled");

    const publicConfigDisabled = await request(app).get("/api/public/site-config");
    expect(publicConfigDisabled.body.booksPageEnabled).toBe(false);

    const enable = await request(app)
      .put("/api/admin/site-config")
      .set("x-admin-token", token)
      .send({ booksPageEnabled: true });
    expect(enable.status).toBe(200);
    expect(enable.body.config.booksPageEnabled).toBe(true);

    const listRestored = await request(app).get("/api/student/books");
    expect(listRestored.status).toBe(200);
    expect(listRestored.body.books.map((b: { id: string }) => b.id)).toContain(book.id);

    const detailRestored = await request(app).get(`/api/student/books/${book.id}`);
    expect(detailRestored.status).toBe(200);
    expect(detailRestored.body.book.id).toBe(book.id);
  });

  it("still 404s a genuinely unknown bookId when enabled (not a false positive from the flag)", async () => {
    const { app } = buildTestApp();

    const detail = await request(app).get("/api/student/books/does-not-exist");
    expect(detail.status).toBe(404);
    expect(detail.body.error).toBe("book not found");
  });
});
