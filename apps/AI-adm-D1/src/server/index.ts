import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getDb, createRepositories, runMigrations, AiProviderIdentityConflictError } from "@ai-smartbook/db";
import {
  createAiProvider,
  AiGatewayError,
  resolveGuestAskRetentionDays,
  redactSensitiveText,
  selectGuestSystemPrompt,
  classifyCredentialVerification,
  healthForCredentialVerification,
  validateCredentialActivation,
  validateQwenEndpoint,
  type ProviderBillingMode,
  type StoredCredentialUsageScope,
} from "@ai-smartbook/ai";
import {
  hmacVisitorIp,
  resolveGuestAskIpHmacSecret,
  generateRecoveryToken,
  digestRecoveryToken
} from "@ai-smartbook/ai/server";
import { buildGateway } from "./ai/gateway-instance";
import { makeAnalyticsService, todayTaipei } from "./ai/analytics-service";
import { createAdminAuthMiddleware } from "./ai/admin-auth";
import { createAdminOriginMiddleware } from "./ai/admin-origin";
import { EvaluationServiceError, makeEvaluationService } from "./ai/evaluation-service";
import { LiveEvaluationServiceError, makeLiveEvaluationService } from "./ai/live-evaluation-service";
import { EvaluationGovernanceError, makeEvaluationGovernanceService } from "./ai/evaluation-governance-service";
import { PilotServiceError, makePilotService } from "./ai/pilot-service";
import { loadRootEnv } from "./env";
import { isValidDateOnly, parseAnalyticsRange as parseAnalyticsDateRange } from "./ai/analytics-query";
import {
  createAiBudgetPolicyInputSchema,
  updateAiBudgetPolicyInputSchema,
  upsertAiProviderConfigInputSchema,
  createAiCredentialInputSchema,
  updateAiCredentialInputSchema,
  createAiCredentialModelQuotaInputSchema,
  updateAiCredentialModelQuotaInputSchema,
  createAiTokenPoolInputSchema,
  updateAiTokenPoolInputSchema,
  upsertAiLogicalModelInputSchema,
  updateAiLogicalModelInputSchema,
  updateAiModelDailyLimitInputSchema
} from "@ai-smartbook/schema";
import { encryptCredential, credentialFingerprint, maskCredential } from "./ai/credential-crypto";
import { CredentialBackedProvider, defaultModelForManagedProvider } from "./ai/credential-provider";

const rootEnv = loadRootEnv();
console.log(`ADMIN_API_TOKEN: ${rootEnv.adminTokenConfigured ? "configured" : "missing"}`);
console.log(`AI_CREDENTIAL_ENCRYPTION_KEY: ${rootEnv.credentialEncryptionKeyConfigured ? "configured" : "missing"}`);

const { db, sqlite } = getDb();
runMigrations(sqlite);
const repos = createRepositories(db);
const ai = createAiProvider();

const { gateway: aiGateway, config: gatewayConfig } = buildGateway(repos);
const guestAskIpHmacSecret = resolveGuestAskIpHmacSecret();
const guestAskRetentionDays = resolveGuestAskRetentionDays();

try {
  const { deleted } = repos.guestAskAnswers.cleanupExpired(new Date().toISOString());
  if (deleted > 0) {
    console.log(`[guest-ask] startup cleanup removed ${deleted} expired answer(s)`);
  }
} catch (err) {
  console.warn("[guest-ask] startup cleanup failed", err instanceof Error ? err.message : err);
}
const analytics = makeAnalyticsService(repos, {
  dailyTokenLimit: gatewayConfig.dailyTokenLimit,
  dailyCostLimitUsd: gatewayConfig.dailyCostLimitUsd
});
const evaluationService = makeEvaluationService(repos, (action, targetId, metadata) => {
  repos.aiProviders.audit(action, "ai_evaluation_run", targetId, metadata);
});
const liveEvaluationService = makeLiveEvaluationService(repos, (action, targetId, metadata) => {
  repos.aiProviders.audit(action, "ai_evaluation_live", targetId, metadata);
});
const evaluationGovernanceService = makeEvaluationGovernanceService(repos, evaluationService, (action, targetId, metadata) => {
  repos.aiProviders.audit(action, "ai_evaluation_governance", targetId, metadata);
});
const pilotService = makePilotService(repos, liveEvaluationService, (action, targetId, metadata) => {
  repos.aiProviders.audit(action, "ai_multi_model_pilot", targetId, metadata);
});

if (process.env.AI_EVALUATION_SCHEDULER_ENABLED === "true") {
  const timer = setInterval(() => { void evaluationGovernanceService.runDue(new Date(), "scheduler"); }, 60_000);
  timer.unref();
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api/admin", createAdminOriginMiddleware());
app.use("/api/admin", createAdminAuthMiddleware());

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function credentialValidationFailure(res: Response, error: z.ZodError, extraFields?: Record<string, string>) {
  const fields = Object.fromEntries(error.issues.map((issue) => [
    issue.path.join(".") || "credential",
    "欄位格式不正確"
  ]));
  return res.status(422).json({
    error: "Credential 欄位格式不正確",
    message: "Credential 欄位格式不正確",
    code: "validation_error",
    fieldErrors: { ...fields, ...extraFields }
  });
}

function credentialFailure(res: Response, status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
  return res.status(status).json({
    error: message,
    message,
    code,
    ...(fieldErrors ? { fieldErrors } : {})
  });
}

function publicCredential(row: NonNullable<ReturnType<typeof repos.aiProviders.findCredential>>) {
  return {
    id: row.id,
    providerConfigId: row.providerConfigId,
    name: row.name,
    maskedApiKey: row.maskedApiKey,
    baseUrl: row.baseUrl,
    model: row.model,
    status: row.status,
    priority: row.priority,
    weight: row.weight,
    failureCount: row.failureCount,
    cooldownUntil: row.cooldownUntil,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    lastTestLatencyMs: row.lastTestLatencyMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt,
    billingMode: row.billingMode,
    region: row.region,
    endpointProfile: row.endpointProfile,
    usageScope: row.usageScope,
    productionAuthorized: row.productionAuthorized,
    allowEvaluation: row.allowEvaluation,
    evaluationAuthorizedAt: row.evaluationAuthorizedAt,
    providerHealth: row.providerHealth,
    modelQuotas: repos.aiCredentialModelQuotas.list(row.id)
  };
}

app.post("/api/admin/ai-credentials/:credentialId/test", async (req, res) => {
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  const provider = repos.aiProviders.findConfig(credential.providerConfigId);
  if (!provider) return fail(res, 404, "provider not found");
  const started = Date.now();
  const managedProvider = provider.provider as "openai" | "gemini" | "kimi" | "qwen" | "zai";
  let upstreamRequestSent = false;

  if (managedProvider === "qwen") {
    const endpoint = validateQwenEndpoint({
      baseUrl: credential.baseUrl ?? provider.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      region: credential.region ?? undefined,
      endpointProfile: credential.endpointProfile ?? undefined
    });
    if (!endpoint.ok) {
      const reason = endpoint.reason;
      const health = healthForCredentialVerification(reason);
      repos.aiProviders.updateCredential(credential.id, {
        providerHealth: health,
        ...(health === "access_denied" || health === "quota_exhausted"
          ? { status: "disabled", disabledAt: new Date().toISOString() }
          : {})
      });
      repos.aiProviders.recordTest(credential.id, "failed", Date.now() - started);
      repos.aiProviders.audit("credential.tested", "credential", credential.id, {
        result: "failed", validationReason: reason, region: credential.region
      });
      return res.status(422).json({
        status: "failed",
        reason,
        latencyMs: Date.now() - started,
        endpointProfile: credential.endpointProfile ?? null,
        upstreamRequestSent: false
      });
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const adapter = new CredentialBackedProvider(
      managedProvider,
      repos,
      provider.model || defaultModelForManagedProvider(managedProvider),
      credential.id,
      "development_interactive"
    );
    upstreamRequestSent = true;
    await adapter.generate({ requestId: `credential_test_${randomUUID()}`, prompt: "Reply with OK.", maxOutputTokens: 8, signal: controller.signal });
    repos.aiProviders.recordTest(credential.id, "success", Date.now() - started);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, { result: "success", region: credential.region });
    res.json({
      status: "success",
      reason: "連線測試成功",
      latencyMs: Date.now() - started,
      endpointProfile: credential.endpointProfile ?? null,
      upstreamRequestSent: true
    });
  } catch (error) {
    const status = error instanceof AiGatewayError ? error.upstreamStatus : undefined;
    const reason = classifyCredentialVerification({
      status,
      apiKeyPresent: true,
      quotaExhausted: status === 429 && error instanceof AiGatewayError && error.fallbackReason === "quota_exhausted"
    });
    const health = healthForCredentialVerification(reason);
    repos.aiProviders.updateCredential(credential.id, {
      providerHealth: health,
      ...(health === "access_denied" || health === "quota_exhausted"
        ? { status: "disabled", disabledAt: new Date().toISOString() }
        : {})
    });
    repos.aiProviders.recordTest(credential.id, "failed", Date.now() - started);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, {
      result: "failed", validationReason: reason, httpStatus: status, region: credential.region, health
    });
    const responseStatus = reason === "rate_limited" || reason === "quota_exhausted" ? 429 : 503;
    res.status(responseStatus).json({
      status: "failed",
      reason,
      latencyMs: Date.now() - started,
      endpointProfile: credential.endpointProfile ?? null,
      upstreamRequestSent
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((_error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  if (res.headersSent) return;
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.ADMIN_API_PORT || 4300);
const host = process.env.ADMIN_API_HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`AI-adm-D1 API listening on ${host}:${port}`);
});
