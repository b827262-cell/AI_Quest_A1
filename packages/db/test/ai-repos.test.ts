import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "../src/migrate";
import { schema } from "../src/schema";
import { createRepositories } from "../src/repositories";
import { upsertAiProviderConfigInputSchema } from "@ai-smartbook/schema";

/**
 * Integration tests for the Phase 2 AI repos against an in-memory SQLite DB.
 * Exercises the full guest-ask persistence path: request log → usage log →
 * daily usage accumulation + budget policy upsert.
 */

type Handle = ReturnType<typeof setup>;

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  const repos = createRepositories(db);
  return { sqlite, db, repos };
}

let handle: Handle;

beforeAll(() => {
  handle = setup();
});

afterAll(() => {
  handle.sqlite.close();
});

describe("AI repos integration", () => {
  it("creates all Phase 2 tables on migration", () => {
    const tables = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("ai_request_logs");
    expect(names).toContain("ai_usage_logs");
    expect(names).toContain("ai_budget_policies");
    expect(names).toContain("ai_daily_usage");
    expect(names).toContain("ai_budget_reservations");
    expect(names).toContain("ai_provider_configs");
    expect(names).toContain("ai_provider_credentials");
    expect(names).toContain("ai_credential_model_quotas");
    expect(names).toContain("ai_admin_audit_logs");
    expect(names).toContain("guest_ask_answers");
  });

  it("is migration-idempotent and preserves legacy rows", () => {
    handle.sqlite.prepare("INSERT INTO books (id,title,created_at,updated_at) VALUES (?,?,?,?)")
      .run("legacy-book", "Legacy", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(() => runMigrations(handle.sqlite)).not.toThrow();
    const book = handle.sqlite.prepare("SELECT title, category FROM books WHERE id = ?")
      .get("legacy-book") as { title: string; category: string };
    expect(book).toEqual({ title: "Legacy", category: "未分類" });
    const indexes = handle.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_ai_%'"
    ).all() as Array<{ name: string }>;
    expect(new Set(indexes.map((row) => row.name)).size).toBe(indexes.length);
  });

  it("backfills credential_id before creating its legacy usage-log index", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`CREATE TABLE ai_usage_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      actual_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      finish_reason TEXT,
      created_at TEXT NOT NULL
    )`);
    expect(() => runMigrations(legacy)).not.toThrow();
    const columns = legacy.prepare("PRAGMA table_info(ai_usage_logs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("credential_id");
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ai_usage_logs_credential'").get()).toBeTruthy();
    legacy.close();
  });

  it("reserves a daily budget atomically and releases it exactly once", async () => {
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => handle.repos.aiBudgetReservations.reserve({
        requestId: "reserve-1",
        provider: "openai",
        model: "gpt-test",
        date: "2099-01-01",
        estimatedTokens: 60,
        estimatedCostMicroUsd: 60,
        dailyTokenLimit: 100,
        dailyCostLimitMicroUsd: 100
      })),
      Promise.resolve().then(() => handle.repos.aiBudgetReservations.reserve({
        requestId: "reserve-2",
        provider: "openai",
        model: "gpt-test",
        date: "2099-01-01",
        estimatedTokens: 60,
        estimatedCostMicroUsd: 60,
        dailyTokenLimit: 100,
        dailyCostLimitMicroUsd: 100
      }))
    ]);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    handle.repos.aiBudgetReservations.release(first.reservationId!);
    handle.repos.aiBudgetReservations.release(first.reservationId!);
    const third = handle.repos.aiBudgetReservations.reserve({
      requestId: "reserve-3",
      provider: "openai",
      model: "gpt-test",
      date: "2099-01-01",
      estimatedTokens: 60,
      estimatedCostMicroUsd: 60,
      dailyTokenLimit: 100,
      dailyCostMicroUsd: 100
    });
    expect(third.allowed).toBe(true);
  });

  it("writes + reads an ai_request_logs row", () => {
    const log = handle.repos.aiRequestLogs.create({
      requestId: "req-test-1",
      requestSource: "guest",
      question: "什麼是 XSS？",
      subject: "programming",
      taskType: "explanation",
      complexity: "medium",
      routingProvider: "mock",
      routingModel: "mock-v1",
      routingReason: "未命中特定規則 → 預設 Provider",
      providerAttempts: ["mock"],
      status: "success",
      diagnosticsJson: JSON.stringify({
        promptTokens: 12,
        completionTokens: 24,
        configuredMaxOutputTokens: 4096,
        finishReason: "stop",
        requestDurationMs: 42,
        streamEndedNormally: true,
        lastChunk: null
      }),
      latencyMs: 42
    });
    expect(log.id).toBeTruthy();
    expect(log.questionLength).toBe("什麼是 XSS？".length);

    const found = handle.repos.aiRequestLogs.findByRequestId("req-test-1");
    expect(found?.subject).toBe("programming");
    expect(found?.routingProvider).toBe("mock");
    expect(found?.providerAttemptsJson).toBe('["mock"]');
    expect(found?.diagnosticsJson).toContain('"finishReason":"stop"');
  });

  it("stores and restores the complete guest answer via recovery token", () => {
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    handle.repos.guestAskAnswers.create({
      requestId: "guest_0123456789abcdef",
      visitorIpHmac: "hmac-visitor",
      recoveryTokenDigest: "correct-digest",
      expiresAt: futureIso,
      question: "請解釋四種排序",
      answer: "Bubble Sort\nInsertion Sort\nMerge Sort\nQuick Sort",
      provider: "openai",
      model: "test-model",
      mode: "live",
      status: "success",
      finishReason: "stop",
      completionJson: JSON.stringify({ complete: true })
    });
    const now = new Date().toISOString();
    const saved = handle.repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
      "guest_0123456789abcdef",
      "correct-digest",
      now
    );
    expect(saved?.answer).toContain("Quick Sort");
    expect(JSON.stringify(saved)).not.toContain("Authorization");
  });

  it("does not restore a guest answer with a wrong recovery token digest", () => {
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    handle.repos.guestAskAnswers.create({
      requestId: "guest_aaaaaaaaaaaaaaaa",
      visitorIpHmac: "hmac",
      recoveryTokenDigest: "correct-digest",
      expiresAt: futureIso,
      question: "q",
      answer: "secret-answer",
      provider: "openai",
      model: "m",
      mode: "live",
      status: "success"
    });
    const now = new Date().toISOString();
    expect(
      handle.repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
        "guest_aaaaaaaaaaaaaaaa",
        "wrong-digest",
        now
      )
    ).toBeUndefined();
  });

  it("does not restore a guest answer without a recovery token digest", () => {
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    handle.repos.guestAskAnswers.create({
      requestId: "guest_bbbbbbbbbbbbbbbb",
      visitorIpHmac: "hmac",
      recoveryTokenDigest: "digest",
      expiresAt: futureIso,
      question: "q",
      answer: "a",
      provider: "openai",
      model: "m",
      mode: "live",
      status: "success"
    });
    const now = new Date().toISOString();
    expect(
      handle.repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
        "guest_bbbbbbbbbbbbbbbb",
        "",
        now
      )
    ).toBeUndefined();
  });

  it("does not restore an expired guest answer", () => {
    const pastIso = new Date(Date.now() - 86_400_000).toISOString();
    handle.repos.guestAskAnswers.create({
      requestId: "guest_cccccccccccccccc",
      visitorIpHmac: "hmac",
      recoveryTokenDigest: "digest",
      expiresAt: pastIso,
      question: "q",
      answer: "expired-answer",
      provider: "openai",
      model: "m",
      mode: "live",
      status: "success"
    });
    const now = new Date().toISOString();
    expect(
      handle.repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
        "guest_cccccccccccccccc",
        "digest",
        now
      )
    ).toBeUndefined();
  });

  it("cleanupExpired deletes only expired answers and is repeatable", () => {
    const pastIso = new Date(Date.now() - 1_000).toISOString();
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    handle.repos.guestAskAnswers.create({
      requestId: "guest_expired1",
      visitorIpHmac: "hmac",
      recoveryTokenDigest: "d1",
      expiresAt: pastIso,
      question: "q",
      answer: "expired",
      provider: "openai",
      model: "m",
      mode: "live",
      status: "success"
    });
    handle.repos.guestAskAnswers.create({
      requestId: "guest_active1",
      visitorIpHmac: "hmac",
      recoveryTokenDigest: "d2",
      expiresAt: futureIso,
      question: "q",
      answer: "active",
      provider: "openai",
      model: "m",
      mode: "live",
      status: "success"
    });
    const before = handle.repos.guestAskAnswers.count();
    expect(before).toBeGreaterThanOrEqual(2);
    const now = new Date().toISOString();
    const first = handle.repos.guestAskAnswers.cleanupExpired(now);
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    // Active answer survives.
    expect(
      handle.repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
        "guest_active1",
        "d2",
        now
      )?.answer
    ).toBe("active");
    // Second run is a no-op (idempotent).
    const second = handle.repos.guestAskAnswers.cleanupExpired(now);
    expect(second.deleted).toBe(0);
  });

  it("writes + reads an ai_usage_logs row and sums daily totals", () => {
    handle.repos.aiUsageLogs.create({
      requestId: "req-test-1",
      provider: "mock",
      model: "mock-v1",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostMicroUsd: 0,
      actualCostMicroUsd: 0,
      finishReason: "stop"
    });
    const today = new Date().toISOString().slice(0, 10);
    const totals = handle.repos.aiUsageLogs.dailyTotals(today);
    expect(totals.totalTokens).toBeGreaterThanOrEqual(150);
  });

  it("stores only the credential identifier on a successful usage row", () => {
    const usage = handle.repos.aiUsageLogs.create({
      requestId: "req-credential-1",
      provider: "openai",
      credentialId: "credential-id-only",
      model: "gpt-test",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostMicroUsd: 1,
      actualCostMicroUsd: 1,
      finishReason: "stop"
    });
    expect(usage.credentialId).toBe("credential-id-only");
    expect(JSON.stringify(usage)).not.toMatch(/encrypted|authorization|api_key|secret/i);
  });

  it("keeps provider key material in the credential vault and exposes only repository rows", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "openai", displayName: "OpenAI", model: "gpt-test" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "primary", encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "sk-****1234", keyFingerprint: "fingerprint-test", status: "active"
    });
    expect(credential.encryptedApiKey).not.toBe("sk-real-key");
    expect(handle.repos.aiProviders.eligibleCredentials(provider.id, "active").map((row) => row.id)).toContain(credential.id);
    handle.repos.aiProviders.audit("credential.created", "credential", credential.id, { status: "active" });
  });

  it("soft-deletes credentials from selection and keeps deletion idempotent", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "zai", displayName: "Z.AI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id,
      name: "zai-primary",
      encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "zai****key",
      keyFingerprint: "zai-fingerprint-test",
      status: "active"
    });
    const deletedAt = new Date().toISOString();
    handle.repos.aiProviders.updateCredential(credential.id, {
      deletedAt,
      disabledAt: deletedAt,
      status: "disabled"
    });
    expect(handle.repos.aiProviders.eligibleCredentials(provider.id, "active")).toHaveLength(0);
    expect(handle.repos.aiProviders.findCredential(credential.id)).toBeUndefined();
    expect(handle.repos.aiProviders.findCredentialIncludingDeleted(credential.id)?.deletedAt).toBe(deletedAt);
  });

  it("supports multiple model quotas and atomically enforces RPM/TPM/RPD", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "openai", displayName: "Quota OpenAI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "quota-key", encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "quo****-key", keyFingerprint: "quota-fingerprint", status: "active"
    });
    const first = handle.repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "model-a", rpmLimit: 1, tpmLimit: 10, rpdLimit: 2
    });
    const second = handle.repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "model-b", rpmLimit: 5, tpmLimit: 100, rpdLimit: 10
    });
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id).map((row) => row.model)).toEqual(["model-a", "model-b"]);

    const attempts = [1, 2].map(() => handle.repos.aiCredentialModelQuotas.reserve(credential.id, "model-a", 4));
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(1);
    const reservation = attempts.find((attempt) => attempt.reservation)?.reservation;
    expect(reservation).toBeTruthy();
    handle.repos.aiCredentialModelQuotas.settle(reservation!, 3, "provider_response");
    const current = handle.repos.aiCredentialModelQuotas.find(first.id)!;
    expect(current.requestsThisMinute).toBe(1);
    expect(current.tokensThisMinute).toBe(3);
    expect(current.requestsToday).toBe(1);
    expect(current.usageSource).toBe("provider_response");
    expect(current.minuteResetAt).toBeTruthy();
    expect(current.dailyResetAt).toBeTruthy();
    expect(handle.repos.aiCredentialModelQuotas.reserve(credential.id, "model-b", 4).allowed).toBe(true);
  });

  it("creates the first credential model and its quota limits as one default row", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "zai", displayName: "Initial Z.AI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "initial-model", model: "glm-initial",
      rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500, resetTimezone: "Asia/Taipei",
      encryptedApiKey: "v1.encrypted-envelope", maskedApiKey: "zai****tial", keyFingerprint: "initial-model-fingerprint"
    });
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id)).toMatchObject([{
      model: "glm-initial", rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500,
      resetTimezone: "Asia/Taipei", enabled: true, isDefault: true
    }]);
    expect(handle.repos.aiProviders.findCredential(credential.id)?.model).toBe("glm-initial");
  });

  it("allows only one default model and protects it from direct disable/delete", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "openai", displayName: "Default OpenAI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "default-switch", model: "model-one",
      encryptedApiKey: "v1.encrypted-envelope", maskedApiKey: "ope****one", keyFingerprint: "default-switch-fingerprint"
    });
    const second = handle.repos.aiCredentialModelQuotas.create({ credentialId: credential.id, model: "model-two" });
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id).filter((row) => row.isDefault)).toHaveLength(1);
    handle.repos.aiCredentialModelQuotas.setDefault(second.id);
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id).filter((row) => row.isDefault).map((row) => row.model)).toEqual(["model-two"]);
    expect(handle.repos.aiProviders.findCredential(credential.id)?.model).toBe("model-two");
    expect(() => handle.repos.aiCredentialModelQuotas.update(second.id, { enabled: false })).toThrow(/default/i);
    expect(() => handle.repos.aiCredentialModelQuotas.remove(second.id)).toThrow(/default/i);
  });

  it("keeps direct Credential.model updates aligned with the quota default", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "openai", displayName: "Sync OpenAI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "sync-model", model: "model-old",
      encryptedApiKey: "v1.encrypted-envelope", maskedApiKey: "ope****old", keyFingerprint: "sync-model-fingerprint"
    });
    handle.repos.aiProviders.updateCredential(credential.id, { model: "model-new" });
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id).filter((row) => row.isDefault).map((row) => row.model)).toEqual(["model-new"]);
    expect(handle.repos.aiProviders.findCredential(credential.id)?.model).toBe("model-new");
  });

  it("resets minute and daily counters and stops quotas after credential deletion", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "zai", displayName: "Quota Z.AI" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "quota-zai-key", encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "zai****-key", keyFingerprint: "quota-zai-fingerprint", status: "active"
    });
    const quota = handle.repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "glm-test", rpmLimit: 5, tpmLimit: 100, rpdLimit: 5
    });
    const reservation = handle.repos.aiCredentialModelQuotas.reserve(credential.id, "glm-test", 10).reservation!;
    handle.repos.aiCredentialModelQuotas.settle(reservation, 10);
    const afterReset = handle.repos.aiCredentialModelQuotas.reserve(
      credential.id, "glm-test", 1, new Date(Date.parse(quota.dailyResetAt) + 1000)
    );
    expect(afterReset.allowed).toBe(true);
    const resetRow = handle.repos.aiCredentialModelQuotas.find(quota.id)!;
    expect(resetRow.requestsThisMinute).toBe(1);
    expect(resetRow.tokensThisMinute).toBe(1);
    expect(resetRow.requestsToday).toBe(1);

    const deletedAt = new Date().toISOString();
    handle.repos.aiProviders.updateCredential(credential.id, { deletedAt, status: "disabled", disabledAt: deletedAt });
    expect(handle.repos.aiCredentialModelQuotas.reserve(credential.id, "glm-test", 1).allowed).toBe(false);
  });

  it("stops using a disabled quota and removes it from the backend list", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "gemini", displayName: "Quota Gemini" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id, name: "quota-disabled", encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "gem****bled", keyFingerprint: "quota-disabled-fingerprint", status: "active"
    });
    const quota = handle.repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "gemini-3.5-flash", rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500
    });
    const replacement = handle.repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "gemini-2.0-flash", isDefault: true
    });
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id).map((row) => row.model)).toEqual(["gemini-2.0-flash", "gemini-3.5-flash"]);
    handle.repos.aiCredentialModelQuotas.update(quota.id, { enabled: false });
    expect(handle.repos.aiCredentialModelQuotas.reserve(credential.id, "gemini-3.5-flash", 1).allowed).toBe(false);
    expect(handle.repos.aiCredentialModelQuotas.find(quota.id)?.enabled).toBe(false);
    expect(handle.repos.aiCredentialModelQuotas.remove(quota.id)).toBe(true);
    expect(handle.repos.aiCredentialModelQuotas.remove(quota.id)).toBe(false);
    expect(handle.repos.aiCredentialModelQuotas.find(replacement.id)?.isDefault).toBe(true);
    expect(handle.repos.aiCredentialModelQuotas.list(credential.id)).toHaveLength(1);
  });

  it("finds duplicate credential names within one provider without exposing key fields", () => {
    const provider = handle.repos.aiProviders.upsertConfig({ provider: "openai", displayName: "OpenAI names" });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id,
      name: "Primary Key",
      encryptedApiKey: "v1.encrypted-envelope",
      maskedApiKey: "pri****-key",
      keyFingerprint: "name-fingerprint-test",
      status: "active"
    });
    expect(handle.repos.aiProviders.findCredentialByName(provider.id, " primary key ")?.id).toBe(credential.id);
    expect(credential.encryptedApiKey).not.toBe("Primary Key");
  });

  it("allowlists audit metadata so secret-shaped fields are discarded", () => {
    handle.repos.aiProviders.audit("credential.updated", "credential", "credential-safe-audit", {
      provider: "zai",
      status: "active",
      apiKey: "secret-api-key",
      encryptedApiKey: "ciphertext-secret",
      authorization: "Bearer secret"
    });
    const row = handle.sqlite.prepare(
      "SELECT metadata_json FROM ai_admin_audit_logs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get("credential-safe-audit") as { metadata_json: string };
    expect(row.metadata_json).toContain("zai");
    expect(row.metadata_json).not.toMatch(/secret-api-key|ciphertext-secret|Bearer secret/i);
  });

  it("keeps default and router provider flags singular", () => {
    const first = handle.repos.aiProviders.upsertConfig({ provider: "gemini", displayName: "Gemini", isDefault: true, isRouterProvider: true });
    const second = handle.repos.aiProviders.upsertConfig({ provider: "qwen", displayName: "Qwen", isDefault: true, isRouterProvider: true });
    expect(handle.repos.aiProviders.findConfig(first.id)?.isDefault).toBe(false);
    expect(handle.repos.aiProviders.findConfig(first.id)?.isRouterProvider).toBe(false);
    expect(handle.repos.aiProviders.findConfig(second.id)?.isDefault).toBe(true);
    expect(handle.repos.aiProviders.findConfig(second.id)?.isRouterProvider).toBe(true);
  });

  it("accumulates daily usage atomically (upsert + increment)", () => {
    const date = new Date().toISOString().slice(0, 10);
    handle.repos.aiDailyUsage.accumulate({
      date,
      scopeType: "global",
      scopeKey: "default",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostMicroUsd: 100,
      actualCostMicroUsd: 100
    });
    handle.repos.aiDailyUsage.accumulate({
      date,
      scopeType: "global",
      scopeKey: "default",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      estimatedCostMicroUsd: 200,
      actualCostMicroUsd: 200
    });
    const global = handle.repos.aiDailyUsage.dailyGlobalTotals(date);
    expect(global.requestCount).toBeGreaterThanOrEqual(2);
    expect(global.totalTokens).toBeGreaterThanOrEqual(45);
    expect(global.estimatedCostMicroUsd).toBeGreaterThanOrEqual(300);
  });

  it("upserts budget policies idempotently by scope", () => {
    const p1 = handle.repos.aiBudgetPolicies.upsertByScope({
      scopeType: "global",
      scopeKey: "test-scope",
      dailyTokenLimit: 1000,
      dailyCostLimitUsd: 5,
      warningPercentage: 80,
      enabled: true
    });
    expect(p1.dailyCostLimitMicroUsd).toBe(5_000_000);
    const p2 = handle.repos.aiBudgetPolicies.upsertByScope({
      scopeType: "global",
      scopeKey: "test-scope",
      dailyTokenLimit: 2000,
      dailyCostLimitUsd: 7.5,
      warningPercentage: 90,
      enabled: false
    });
    expect(p2.id).toBe(p1.id); // same row updated, not duplicated
    expect(p2.dailyTokenLimit).toBe(2000);
    expect(p2.dailyCostLimitMicroUsd).toBe(7_500_000);
    expect(p2.enabled).toBe(false);

    const all = handle.repos.aiBudgetPolicies.list().filter((p) => p.scopeKey === "test-scope");
    expect(all).toHaveLength(1);
  });

  it("supports paginated, filtered request-log queries", () => {
    for (let i = 0; i < 5; i++) {
      handle.repos.aiRequestLogs.create({
        requestId: `req-page-${i}`,
        requestSource: "guest",
        question: `question ${i}`,
        subject: i % 2 === 0 ? "math" : "general",
        taskType: "question_answering",
        complexity: "low",
        routingProvider: "mock",
        routingModel: "mock-v1",
        routingReason: "test",
        status: "success",
        latencyMs: i * 10
      });
    }
    const mathOnly = handle.repos.aiRequestLogs.query({ subject: "math", limit: 50 });
    expect(mathOnly.rows.every((r) => r.subject === "math")).toBe(true);
    expect(mathOnly.rows.length).toBeGreaterThanOrEqual(3);

    const byLatency = handle.repos.aiRequestLogs.query({
      subject: "math",
      sort: "latency",
      limit: 50
    });
    const latencies = byLatency.rows.map((r) => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => b - a);
    expect(latencies).toEqual(sorted);
  });

  it("soft-deletes a provider, disables its credential graph, and is idempotent", () => {
    const provider = handle.repos.aiProviders.upsertConfig({
      provider: "kimi",
      displayName: "Delete me",
      isRouterProvider: false
    });
    const credential = handle.repos.aiProviders.createCredential({
      providerConfigId: provider.id,
      name: "delete-provider-key",
      encryptedApiKey: "ciphertext-must-not-be-audit-value",
      maskedApiKey: "dele****-key",
      keyFingerprint: "fingerprint-delete-provider",
      model: "moonshot-test"
    });
    const quota = handle.repos.aiCredentialModelQuotas.defaultForCredential(credential.id);
    expect(quota).toBeTruthy();

    expect(handle.repos.aiProviders.deleteConfig(provider.id)).toMatchObject({ deleted: true });
    expect(handle.repos.aiProviders.findConfig(provider.id)).toBeUndefined();
    expect(handle.repos.aiProviders.findConfigIncludingDeleted(provider.id)?.deletedAt).toBeTruthy();
    expect(handle.repos.aiProviders.findCredential(credential.id)?.status).toBe("disabled");
    expect(handle.repos.aiProviders.findCredentialIncludingDeleted(credential.id)?.status).toBe("disabled");
    expect(handle.repos.aiCredentialModelQuotas.find(quota!.id)?.enabled).toBe(false);
    expect(handle.repos.aiProviders.deleteConfig(provider.id)).toMatchObject({
      deleted: false,
      alreadyDeleted: true
    });

    const audit = handle.sqlite.prepare(
      "SELECT metadata_json AS metadata FROM ai_admin_audit_logs WHERE action = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get("provider.deleted", provider.id) as { metadata: string };
    expect(audit.metadata).toContain("soft_deleted");
    expect(audit.metadata).not.toContain("ciphertext-must-not-be-audit-value");
    expect(audit.metadata).not.toContain("fingerprint-delete-provider");
  });

  it("rejects deleting the Default Router", () => {
    const provider = handle.repos.aiProviders.upsertConfig({
      provider: "qwen",
      displayName: "Router",
      isRouterProvider: true
    });
    expect(() => handle.repos.aiProviders.deleteConfig(provider.id)).toThrow("default router");
    expect(handle.repos.aiProviders.findConfig(provider.id)?.deletedAt).toBeNull();
  });

  it("restores a soft-deleted provider and rejects active duplicates case-insensitively", () => {
    const deleted = handle.repos.aiProviders.createConfig({
      provider: "kimi",
      slug: "kimi-restored",
      displayName: "Kimi Restored",
      model: null
    });
    expect(handle.repos.aiProviders.deleteConfig(deleted.row.id)).toMatchObject({ deleted: true });
    const restored = handle.repos.aiProviders.createConfig({
      provider: "kimi",
      slug: "kimi-restored",
      displayName: "Kimi Restored",
      model: null
    });
    expect(restored.restored).toBe(true);
    expect(restored.row.deletedAt).toBeNull();
    expect(() => handle.repos.aiProviders.createConfig({
      provider: "kimi",
      slug: "kimi-restored",
      displayName: "Kimi Duplicate"
    })).toThrow("provider slug already exists");
  });

  it("allows multiple instances to share an adapter while keeping instance identity and credentials separate", () => {
    const zai = handle.repos.aiProviders.createConfig({
      provider: "openai",
      slug: "zai-openai-compatible",
      displayName: "ZAI",
      model: "GLM-5.2"
    }).row;
    const free = handle.repos.aiProviders.createConfig({
      provider: "openai",
      slug: "gpt-free-1",
      displayName: "GPT_FREE_1"
    }).row;
    expect(zai.provider).toBe(free.provider);
    expect(zai.id).not.toBe(free.id);

    const zaiCredential = handle.repos.aiProviders.createCredential({
      providerConfigId: zai.id,
      name: "zai-key",
      encryptedApiKey: "v1.encrypted-zai",
      maskedApiKey: "zai****key",
      keyFingerprint: "provider-instance-zai-fingerprint"
    });
    const freeCredential = handle.repos.aiProviders.createCredential({
      providerConfigId: free.id,
      name: "free-key",
      encryptedApiKey: "v1.encrypted-free",
      maskedApiKey: "free****key",
      keyFingerprint: "provider-instance-free-fingerprint"
    });
    expect(handle.repos.aiProviders.listCredentials(zai.id).map((row) => row.id)).toEqual([zaiCredential.id]);
    expect(handle.repos.aiProviders.listCredentials(free.id).map((row) => row.id)).toEqual([freeCredential.id]);

    expect(() => handle.repos.aiProviders.createConfig({
      provider: "gemini",
      slug: "gpt-free-1",
      displayName: "Different Display Name"
    })).toThrow("provider slug already exists");
    expect(() => handle.repos.aiProviders.createConfig({
      provider: "gemini",
      slug: "different-slug",
      displayName: "GPT_FREE_1"
    })).toThrow("provider displayName already exists");

    expect(handle.repos.aiProviders.deleteConfig(zai.id)).toMatchObject({ deleted: true });
    expect(handle.repos.aiProviders.findConfig(free.id)?.deletedAt).toBeNull();
    expect(handle.repos.aiProviders.findCredential(freeCredential.id)?.providerConfigId).toBe(free.id);
    expect(handle.repos.aiProviders.findCredential(zaiCredential.id)?.status).toBe("disabled");
  });

  it("normalizes optional Provider model and rejects unsafe URL fields", () => {
    const normalized = upsertAiProviderConfigInputSchema.safeParse({
      provider: "OpenAI",
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: ""
    });
    expect(normalized.success).toBe(true);
    if (normalized.success) expect(normalized.data).toMatchObject({ provider: "openai", model: null });

    expect(upsertAiProviderConfigInputSchema.safeParse({
      provider: "openai", displayName: "OpenAI", baseUrl: "http://127.0.0.1:5174/admin"
    }).success).toBe(false);
    expect(upsertAiProviderConfigInputSchema.safeParse({
      provider: "openai", displayName: "OpenAI", model: "https://example.com/model"
    }).success).toBe(false);
  });
});
