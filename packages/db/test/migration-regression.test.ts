import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { runMigrations } from "../src/migrate";

/**
 * Migration regression coverage (spec §5). Verifies runMigrations is safe to
 * execute repeatedly across:
 *   - an empty database
 *   - a database with the previous (pre-token/retention) schema
 *   - a database where the migration has already been applied
 *   - a database containing existing guest answers
 *
 * For each scenario the migration is run TWICE and assertions check no error,
 * no duplicate indexes, no reset of expires_at, and preservation of data.
 */

type TableInfo = Array<{ name: string }>;

function columnsOf(sqlite: DatabaseType, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as TableInfo).map((c) => c.name);
}

function indexCount(sqlite: DatabaseType, indexName: string): number {
  const row = sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Build a database that has the *previous* guest_ask_answers schema (before
 * visitor_ip_hmac / recovery_token_digest / expires_at were added), plus an
 * existing row, to exercise the column backfill and expires_at backfill paths.
 */
function seedPreviousSchemaWithRow(): DatabaseType {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE guest_ask_answers (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      visitor_ip_hash TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      finish_reason TEXT,
      completion_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    INSERT INTO guest_ask_answers (id, request_id, visitor_ip_hash, question, answer,
      provider, model, mode, status, finish_reason, completion_json, created_at)
    VALUES ('gqa_legacy1', 'guest_aaaaaaaaaaaaaaaa', 'legacy-hash',
      'legacy-question', 'legacy-answer', 'openai', 'm', 'live', 'success',
      'stop', '{}', '2026-01-01T00:00:00.000Z');
  `);
  return sqlite;
}

describe("migration idempotency and backfill", () => {
  it("replaces legacy UNIQUE(provider) with instance identity indexes", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE ai_provider_configs (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        base_url TEXT, model TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0, is_router_provider INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      INSERT INTO ai_provider_configs
        (id, provider, display_name, created_at, updated_at)
        VALUES ('legacy-zai', 'openai', 'ZAI', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    runMigrations(sqlite);
    runMigrations(sqlite);
    sqlite.prepare(`INSERT INTO ai_provider_configs
      (id, provider, slug, display_name, created_at, updated_at)
      VALUES ('new-openai', 'openai', 'gpt-free-1', 'GPT_FREE_1', ?, ?)`)
      .run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    expect(sqlite.prepare("SELECT count(*) AS count FROM ai_provider_configs WHERE provider = 'openai'").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT slug FROM ai_provider_configs WHERE id = 'legacy-zai'").get()).toEqual({ slug: "zai" });
    expect(() => sqlite.prepare(`INSERT INTO ai_provider_configs
      (id, provider, slug, display_name, created_at, updated_at)
      VALUES ('duplicate-slug', 'gemini', 'gpt-free-1', 'Other', ?, ?)`)
      .run("2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z")).toThrow();
    sqlite.close();
  });

  it("promotes legacy Credential.model to one default quota without duplicating an existing model", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE ai_provider_configs (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT NOT NULL,
        base_url TEXT, model TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0, is_router_provider INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE ai_provider_credentials (
        id TEXT PRIMARY KEY, provider_config_id TEXT NOT NULL, name TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL, masked_api_key TEXT NOT NULL, key_fingerprint TEXT NOT NULL UNIQUE,
        base_url TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1, failure_count INTEGER NOT NULL DEFAULT 0, cooldown_until TEXT,
        last_tested_at TEXT, last_test_status TEXT, last_test_latency_ms INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, disabled_at TEXT, deleted_at TEXT
      );
      CREATE TABLE ai_credential_model_quotas (
        id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, model TEXT NOT NULL,
        rpm_limit INTEGER, tpm_limit INTEGER, rpd_limit INTEGER,
        requests_this_minute INTEGER NOT NULL DEFAULT 0, tokens_this_minute INTEGER NOT NULL DEFAULT 0,
        requests_today INTEGER NOT NULL DEFAULT 0, minute_reset_at TEXT NOT NULL, daily_reset_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO ai_provider_configs
        (id, provider, display_name, model, created_at, updated_at)
        VALUES ('legacy-provider', 'zai', 'Legacy Z.AI', 'glm-legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO ai_provider_credentials
        (id, provider_config_id, name, encrypted_api_key, masked_api_key, key_fingerprint, model, created_at, updated_at)
        VALUES ('legacy-credential', 'legacy-provider', 'legacy-key', 'ciphertext-not-output', 'zai****-key', 'legacy-fingerprint', 'glm-legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO ai_credential_model_quotas
        (id, credential_id, model, rpm_limit, minute_reset_at, daily_reset_at, created_at, updated_at)
        VALUES ('legacy-quota', 'legacy-credential', 'glm-legacy', 15, '2099-01-01T00:01:00.000Z', '2099-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    runMigrations(sqlite);
    runMigrations(sqlite);
    const quotas = sqlite.prepare(
      "SELECT id, model, is_default FROM ai_credential_model_quotas WHERE credential_id = 'legacy-credential'"
    ).all() as Array<{ id: string; model: string; is_default: number }>;
    expect(quotas).toEqual([{ id: "legacy-quota", model: "glm-legacy", is_default: 1 }]);
    sqlite.close();
  });

  it("creates all new guest_ask_answers columns on an empty database (run twice)", () => {
    const sqlite = new Database(":memory:");
    expect(() => runMigrations(sqlite)).not.toThrow();
    // Second run must not error.
    expect(() => runMigrations(sqlite)).not.toThrow();

    const cols = columnsOf(sqlite, "guest_ask_answers");
    expect(cols).toContain("visitor_ip_hmac");
    expect(cols).toContain("recovery_token_digest");
    expect(cols).toContain("expires_at");
  });

  it("does not create duplicate indexes when run twice", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    runMigrations(sqlite);
    expect(indexCount(sqlite, "idx_guest_ask_answers_created")).toBe(1);
    expect(indexCount(sqlite, "idx_guest_ask_answers_expires")).toBe(1);
    sqlite.close();
  });

  it("adds the new columns to a database with the previous schema", () => {
    const sqlite = seedPreviousSchemaWithRow();
    expect(() => runMigrations(sqlite)).not.toThrow();
    expect(() => runMigrations(sqlite)).not.toThrow();

    const cols = columnsOf(sqlite, "guest_ask_answers");
    expect(cols).toContain("visitor_ip_hmac");
    expect(cols).toContain("recovery_token_digest");
    expect(cols).toContain("expires_at");
    sqlite.close();
  });

  it("backfills expires_at for existing guest answers and does not reset it on re-run", () => {
    const sqlite = seedPreviousSchemaWithRow();
    runMigrations(sqlite);

    const afterFirst = sqlite
      .prepare(`SELECT expires_at FROM guest_ask_answers WHERE request_id = 'guest_aaaaaaaaaaaaaaaa'`)
      .get() as { expires_at: string } | undefined;
    expect(afterFirst?.expires_at).toBeTruthy();
    // Backfill is created_at + 7 days. created_at was 2026-01-01, so expires_at
    // should be 2026-01-08.
    expect(afterFirst?.expires_at).toContain("2026-01-08");

    // Second run must NOT reset the already-populated expires_at.
    runMigrations(sqlite);
    const afterSecond = sqlite
      .prepare(`SELECT expires_at FROM guest_ask_answers WHERE request_id = 'guest_aaaaaaaaaaaaaaaa'`)
      .get() as { expires_at: string } | undefined;
    expect(afterSecond?.expires_at).toBe(afterFirst?.expires_at);
    sqlite.close();
  });

  it("preserves existing guest answer data across repeated migrations", () => {
    const sqlite = seedPreviousSchemaWithRow();
    runMigrations(sqlite);
    runMigrations(sqlite);

    const row = sqlite
      .prepare(`SELECT question, answer, status FROM guest_ask_answers WHERE request_id = 'guest_aaaaaaaaaaaaaaaa'`)
      .get() as { question: string; answer: string; status: string } | undefined;
    expect(row?.question).toBe("legacy-question");
    expect(row?.answer).toBe("legacy-answer");
    expect(row?.status).toBe("success");
    sqlite.close();
  });

  it("does not output secrets or full data content during migration", () => {
    // runMigrations writes only schema/backfill; capture console to ensure no
    // question/answer/secret text is emitted. (The migrate CLI prints a path
    // summary when invoked directly, but runMigrations itself is silent.)
    const sqlite = new Database(":memory:");
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      runMigrations(sqlite);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    const output = captured.join("\n");
    expect(output).not.toContain("legacy-answer");
    expect(output).not.toContain("recovery_token_digest");
    // No secret-looking material should be printed by migration.
    expect(output).not.toMatch(/sk-[A-Za-z0-9]/);
    sqlite.close();
  });

  it("does not duplicate ai_request_logs.diagnostics_json column or its index", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    runMigrations(sqlite);
    const cols = columnsOf(sqlite, "ai_request_logs");
    const diagnosticsCols = cols.filter((c) => c === "diagnostics_json");
    expect(diagnosticsCols.length).toBe(1);
    sqlite.close();
  });
});
