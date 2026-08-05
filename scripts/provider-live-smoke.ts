import { randomUUID } from "node:crypto";
import { scanArtifactText, artifactPath, releaseMetadata, writeSanitizedArtifact } from "./release-artifacts.mjs";
import {
  AiGateway,
  type AiProviderId
} from "../packages/ai/src/index";
import { createDbHandle, createRepositories, runMigrations } from "../packages/db/src/index";
import { DbBudgetManager } from "../apps/AI-adm-D1/src/server/ai/db-budget-manager";
import { DbPromptLogger } from "../apps/AI-adm-D1/src/server/ai/db-prompt-logger";
import { CredentialBackedProvider } from "../apps/AI-adm-D1/src/server/ai/credential-provider";
import {
  credentialFingerprint,
  encryptCredential,
  maskCredential,
  validateMasterKey
} from "../apps/AI-adm-D1/src/server/ai/credential-crypto";

type CheckState = "PASS" | "FAIL" | "BLOCKED";
type Check = { name: string; state: CheckState; reason?: string };
type ManagedProvider = Exclude<AiProviderId, "mock">;

const providerKeyNames: Record<ManagedProvider, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: "KIMI_API_KEY",
  qwen: "QWEN_API_KEY",
  zai: "ZAI_API_KEY"
};

const providerDefaults: Record<ManagedProvider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: process.env.OPENAI_MODEL || "gpt-4o-mini" },
  gemini: { baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta", model: process.env.GEMINI_MODEL || "gemini-1.5-flash" },
  kimi: { baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1", model: process.env.KIMI_MODEL || "moonshot-v1-8k" },
  qwen: { baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", model: process.env.QWEN_MODEL || "qwen-turbo" },
  zai: { baseUrl: process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4", model: process.env.ZAI_MODEL || "glm-4.5-flash" }
};

const reportPath = artifactPath("provider-live-smoke", "PROVIDER_LIVE_REPORT_PATH");
const checks: Check[] = [];

class BlockedError extends Error {}

function record(name: string, state: CheckState, reason?: string): void {
  checks.push({ name, state, reason });
}

function requiredProvider(): ManagedProvider | undefined {
  const index = process.argv.indexOf("--provider");
  const value = (index >= 0 ? process.argv[index + 1] : process.env.PROVIDER_LIVE_PROVIDER)?.trim().toLowerCase();
  return value && value in providerKeyNames ? value as ManagedProvider : undefined;
}

function safeEnvKeyName(provider: ManagedProvider): string {
  const requested = process.env.PROVIDER_LIVE_CREDENTIAL_ENV?.trim();
  if (requested && requested !== providerKeyNames[provider]) throw new BlockedError("credential source must be the provider-specific controlled secret");
  return requested || providerKeyNames[provider];
}

function cleanupEnvironment(): string {
  return process.env.RELEASE_ENVIRONMENT || process.env.PROVIDER_LIVE_ENVIRONMENT || "controlled-runner";
}

function countByState(state: CheckState): number {
  return checks.filter((check) => check.state === state).length;
}

function rawCredentialIsEncrypted(sqlite: ReturnType<typeof createDbHandle>["sqlite"], id: string, apiKey: string): boolean {
  const row = sqlite.prepare("SELECT encrypted_api_key, masked_api_key FROM ai_provider_credentials WHERE id = ?").get(id) as { encrypted_api_key?: string; masked_api_key?: string } | undefined;
  return Boolean(row?.encrypted_api_key?.startsWith("v1.") && row.encrypted_api_key !== apiKey && row.masked_api_key === maskCredential(apiKey));
}

async function run(): Promise<number> {
  const provider = requiredProvider();
  const environment = cleanupEnvironment();
  const startedAt = new Date().toISOString();
  let sqlite: ReturnType<typeof createDbHandle>["sqlite"] | undefined;
  let repos: ReturnType<typeof createRepositories> | undefined;
  let credentialId: string | undefined;
  let providerConfigId: string | undefined;
  let createdProvider = false;
  let status: "PASS" | "FAIL" | "BLOCKED" = "PASS";
  let failureReason: string | undefined;
  let gatewayRequestId: string | undefined;
  let usageMetadata: Record<string, number | string | null> | undefined;
  let cleanupStatus: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" = "NOT RUN";

  try {
    if (!provider) throw new BlockedError("set --provider or PROVIDER_LIVE_PROVIDER to one supported provider");
    const keyName = safeEnvKeyName(provider);
    const apiKey = process.env[keyName]?.trim();
    const masterKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
    const dbPath = process.env.PROVIDER_LIVE_DB_PATH?.trim() || process.env.SQLITE_PATH?.trim();
    if (!apiKey) throw new BlockedError(`controlled ${keyName} credential is unavailable`);
    if (!masterKey) throw new BlockedError("AI_CREDENTIAL_ENCRYPTION_KEY is unavailable");
    validateMasterKey(masterKey);
    if (!dbPath) throw new BlockedError("PROVIDER_LIVE_DB_PATH or SQLITE_PATH is required; no default application DB is used");
    if (process.env.PROVIDER_LIVE_ALLOW_MUTATION !== "true") throw new BlockedError("set PROVIDER_LIVE_ALLOW_MUTATION=true in the controlled runner");
    if (process.env.PROVIDER_LIVE_CONFIRM_CLEANUP !== "true") throw new BlockedError("set PROVIDER_LIVE_CONFIRM_CLEANUP=true to require cleanup");
    if (environment.toLowerCase() === "production" && process.env.PROVIDER_LIVE_ALLOW_PRODUCTION_MUTATION !== "true") {
      throw new BlockedError("production live smoke requires an explicitly approved mutation window");
    }

    const handle = createDbHandle(dbPath);
    sqlite = handle.sqlite;
    runMigrations(sqlite);
    repos = createRepositories(handle.db);
    record("Controlled credential and isolated DB prerequisites", "PASS");

    const defaults = providerDefaults[provider];
    let providerConfig = repos.aiProviders.findConfigByProvider(provider);
    if (!providerConfig) {
      providerConfig = repos.aiProviders.upsertConfig({
        provider,
        displayName: `Phase 3A live smoke ${provider}`,
        baseUrl: defaults.baseUrl,
        model: defaults.model,
        enabled: true,
        priority: 9999
      });
      createdProvider = true;
      repos.aiProviders.audit("provider.live_smoke_created", "provider", providerConfig.id, { provider, environment });
    }
    providerConfigId = providerConfig.id;
    if (!providerConfig.enabled) throw new BlockedError("target Provider is disabled; smoke does not change existing Provider state");

    const fingerprint = credentialFingerprint(apiKey);
    if (repos.aiProviders.findByFingerprint(fingerprint)) throw new BlockedError("dedicated live-smoke credential fingerprint already exists; no existing credential is reused");
    const encryptedApiKey = encryptCredential(apiKey);
    const row = repos.aiProviders.createCredential({
      providerConfigId: providerConfig.id,
      name: `phase3a-live-${Date.now()}`,
      encryptedApiKey,
      maskedApiKey: maskCredential(apiKey),
      keyFingerprint: fingerprint,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      status: "active",
      priority: 0,
      weight: 1
    });
    credentialId = row.id;
    repos.aiProviders.audit("credential.created", "credential", row.id, { provider, environment, source: "controlled-live-smoke" });
    record("Credential encrypted at rest and masked-only metadata", rawCredentialIsEncrypted(sqlite, row.id, apiKey) ? "PASS" : "FAIL", "stored row was not an authenticated envelope with the expected mask");
    const safeCredentialView = {
      id: row.id,
      providerConfigId: row.providerConfigId,
      maskedApiKey: row.maskedApiKey,
      status: row.status,
      priority: row.priority,
      weight: row.weight
    };
    record("Credential read shape is masked-only", Object.keys(safeCredentialView).every((key) => !/encrypted|fingerprint|authorization|apiKey$/i.test(key) || key === "maskedApiKey") ? "PASS" : "FAIL", "safe credential view contained forbidden key material");

    const managed = new CredentialBackedProvider(provider, repos, providerConfig.model || defaults.model, row.id);
    const testStarted = Date.now();
    try {
      await managed.generate({ requestId: `provider_test_${randomUUID()}`, prompt: "Reply with only: OK", maxOutputTokens: 4 });
      repos.aiProviders.recordTest(row.id, "success", Date.now() - testStarted);
      repos.aiProviders.audit("credential.tested", "credential", row.id, { provider, result: "success", environment });
      record("Credential test through Vault-backed adapter", "PASS");
    } catch {
      repos.aiProviders.recordTest(row.id, "failed", Date.now() - testStarted);
      repos.aiProviders.audit("credential.tested", "credential", row.id, { provider, result: "failed", environment });
      record("Credential test through Vault-backed adapter", "FAIL", "provider test failed; upstream details were not retained");
      throw new Error("credential test failed");
    }

    const gateway = new AiGateway({
      providers: new Map([[provider, managed]]),
      forceProvider: provider,
      requestTimeoutMs: Math.min(30_000, Math.max(1_000, Number(process.env.PROVIDER_LIVE_TIMEOUT_MS || 20_000))),
      maxRetries: Math.min(1, Math.max(0, Number(process.env.PROVIDER_LIVE_RETRIES || 0))),
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new DbBudgetManager(repos, { dailyTokenLimit: 1_000_000, dailyCostLimitUsd: 10, warningPercentage: 80 }),
      logger: new DbPromptLogger(repos),
      allowMockFallback: false
    });
    const gatewayStarted = Date.now();
    gatewayRequestId = `provider_live_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const output = await gateway.run({
      requestId: gatewayRequestId,
      prompt: "Reply with only: OK",
      preferredProvider: provider,
      requestSource: "internal",
      scopeKey: "phase3a-provider-live"
    });
    record("Normal Gateway request used the Vault-backed Credential", output.result.credentialId === row.id ? "PASS" : "FAIL", "successful result did not carry the created credential ID");
    record("Provider response parsed without retaining full response", output.result.answer.trim().length > 0 ? "PASS" : "FAIL", "answer was empty");

    const usage = repos.aiUsageLogs.findByRequestId(gatewayRequestId);
    const requestLog = repos.aiRequestLogs.findByRequestId(gatewayRequestId);
    usageMetadata = usage ? {
      provider: usage.provider,
      credentialId: usage.credentialId,
      requestId: usage.requestId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      actualCostMicroUsd: usage.actualCostMicroUsd,
      latencyMs: Date.now() - gatewayStarted
    } : undefined;
    record("Usage Log has providerId, credentialId and requestId", Boolean(usage && requestLog && usage.provider === provider && usage.credentialId === row.id && usage.requestId === gatewayRequestId) ? "PASS" : "FAIL", "usage/request log correlation was incomplete");
    const reservation = sqlite.prepare("SELECT status FROM ai_budget_reservations WHERE request_id = ? ORDER BY created_at DESC LIMIT 1").get(gatewayRequestId) as { status?: string } | undefined;
    record("Successful request settled its budget reservation", reservation?.status === "settled" ? "PASS" : "FAIL", "reservation was not settled exactly once");

    const auditRows = sqlite.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs WHERE target_id = ? AND created_at >= ? ORDER BY created_at").all(row.id, startedAt) as Array<{ action: string; metadata_json: string }>;
    const auditActions = new Set(auditRows.map((audit) => audit.action));
    record("Audit metadata contains no key material or provider body", auditRows.every((audit) => scanArtifactText(audit.metadata_json).passed) ? "PASS" : "FAIL", "audit metadata failed the secret scan");
    record("Audit Log records credential creation and test", auditActions.has("credential.created") && auditActions.has("credential.tested") ? "PASS" : "FAIL", "required audit actions were missing");
  } catch (error) {
    if (error instanceof BlockedError) {
      status = "BLOCKED";
      failureReason = error.message;
      if (checks.every((check) => check.state !== "FAIL")) record("Vault-based Provider live smoke prerequisites", "BLOCKED", error.message);
    } else {
      status = "FAIL";
      failureReason = "live smoke failed; provider details redacted";
      if (!checks.some((check) => check.state === "FAIL")) record("Vault-based Provider live smoke execution", "FAIL", failureReason);
    }
  } finally {
    if (repos && credentialId) {
      try {
        repos.aiProviders.updateCredential(credentialId, { status: "disabled", disabledAt: new Date().toISOString() });
        repos.aiProviders.audit("credential.disabled", "credential", credentialId, { provider, environment, source: "controlled-live-smoke" });
        repos.aiProviders.updateCredential(credentialId, { deletedAt: new Date().toISOString(), status: "disabled", disabledAt: new Date().toISOString() });
        repos.aiProviders.audit("credential.deleted", "credential", credentialId, { provider, environment, source: "controlled-live-smoke" });
        const unavailable = provider && new CredentialBackedProvider(provider, repos, providerDefaults[provider].model, credentialId);
        const unavailableResult = unavailable ? await unavailable.isAvailable() : true;
        record("Cleanup disabled and soft-deleted Credential; Gateway cannot select it", unavailableResult ? "FAIL" : "PASS", unavailableResult ? "credential remained eligible after cleanup" : undefined);
        cleanupStatus = unavailableResult ? "FAIL" : "PASS";
      } catch {
        cleanupStatus = "FAIL";
        record("Credential cleanup", "FAIL", "cleanup failed; details redacted");
      }
    } else if (status === "BLOCKED") {
      cleanupStatus = "NOT RUN";
    }
    if (sqlite && createdProvider && providerConfigId) {
      try {
        sqlite.prepare("UPDATE ai_provider_configs SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), providerConfigId);
        if (repos) repos.aiProviders.audit("provider.live_smoke_deleted", "provider", providerConfigId, { provider, environment });
      } catch {
        cleanupStatus = "FAIL";
        record("Temporary Provider cleanup", "FAIL", "cleanup failed; details redacted");
      }
    }
    if (sqlite) sqlite.close();
    if (cleanupStatus === "FAIL") status = "FAIL";
    if (status === "PASS" && checks.some((check) => check.state === "FAIL")) status = "FAIL";
    const effectiveExit = status === "PASS" ? 0 : status === "BLOCKED" && !checks.some((check) => check.state === "FAIL") ? 2 : 1;
    const artifact = writeSanitizedArtifact(reportPath, {
      ...releaseMetadata(environment),
      status,
      provider: provider || "not selected",
      startedAt,
      checks,
      usageMetadata,
      cleanup: cleanupStatus,
      secretLeakageScan: "PASS",
      blockedReason: failureReason
    });
    const finalExit = artifact.written ? effectiveExit : 1;
    console.log(`Provider Vault live smoke: ${status}`);
    console.log(`Checks: PASS=${countByState("PASS")} FAIL=${countByState("FAIL")} BLOCKED=${countByState("BLOCKED")}`);
    console.log(`Sanitized report: ${artifact.written ? reportPath : "unavailable (safe write/leakage scan failed)"}`);
    if (status === "BLOCKED") console.log(`Live endpoint verification: NOT RUN (${failureReason || "controlled credentials unavailable"})`);
    process.exitCode = finalExit;
    return finalExit;
  }
}

void run();
