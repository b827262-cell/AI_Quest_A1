import type {
  GatewayLogEntry,
  PromptLogger
} from "@ai-smartbook/ai";
import {
  pricingSnapshotFor,
  serializePricingSnapshot,
  redactSensitiveText,
  toSafeAiDiagnostics
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";

/** Max chars of the answer persisted (after redaction). Generous but bounded. */
const MAX_ANSWER_CHARS = 20_000;

/**
 * DB-backed prompt logger. Writes one ai_request_logs row per gateway run and
 * one ai_usage_logs row when a result is present.
 *
 * Privacy: only the visitor IP *hash* is ever stored (the gateway already
 * receives a hash, never the raw IP). No headers, API keys, system prompts or
 * provider secrets are logged (spec §7). The question and answer bodies are
 * redacted (strips sk-…, AIza…, bearer/api_key tokens) and bounded before
 * persistence; the analytics API exposes only short previews to reduce
 * unnecessary content exposure (spec §2.3).
 *
 * Cost immutability (spec §5.3): the per-component cost breakdown and the
 * pricing snapshot are captured at request time and stored as integers/JSON,
 * so later price edits never change historical rows.
 */
export class DbPromptLogger implements PromptLogger {
  constructor(private readonly repos: Repositories) {}

  async log(entry: GatewayLogEntry): Promise<void> {
    this.repos.aiRequestLogs.create({
      requestId: entry.requestId,
      visitorId: entry.visitorId ?? null,
      visitorIpHash: entry.visitorIpHash ?? null,
      requestSource: entry.requestSource,
      question: redactSensitiveText(entry.question),
      subject: entry.decision.subject,
      taskType: entry.decision.taskType,
      complexity: entry.decision.complexity,
      routingProvider: entry.result?.provider ?? entry.decision.preferredProvider,
      // Managed providers resolve the actual model from the credential quota
      // at call time; persist that effective model for diagnosis.
      routingModel: entry.result?.model ?? entry.decision.preferredModel ?? null,
      routingReason: entry.decision.reason,
      providerAttempts: entry.providerAttempts,
      status: entry.status,
      errorCode: entry.errorCode ?? null,
      // Diagnostics are reduced to an explicit allowlist before persistence.
      // The runtime diagnostics object may carry provider response/error
      // fields; toSafeAiDiagnostics copies only vetted, non-sensitive keys and
      // drops everything else (no spread). See spec §4.
      diagnosticsJson: entry.diagnostics ? JSON.stringify(toSafeAiDiagnostics(entry.diagnostics)) : null,
      latencyMs: entry.latencyMs
    });

    if (entry.result) {
      const r = entry.result;
      // Capture the immutable pricing snapshot (spec §5.3). The breakdown
      // integers below were computed by the gateway at request time from this
      // same pricing, so the stored cost is frozen even if prices later change.
      const snapshot = pricingSnapshotFor(r.provider, r.model, r.pricingConfig);
      const breakdown = r.costBreakdown;
      // usageSource marks whether tokens came from the provider or are
      // estimates; pricingSource follows suit and is NEVER marked provider-
      // official when usage was estimated (spec §6.7).
      const usageSource =
        r.usageSource ?? (r.totalTokens === undefined ? "system_estimated" : "provider_response");
      const pricingSource =
        usageSource === "system_estimated" ? "system_estimated" : (r.pricingSource ?? snapshot.pricing.pricingSource);

      // OpenAI Credential daily ledger settle. The adapter reserved a per-key
      // daily budget before the upstream call; settle it here with the actual
      // usage + cost (the gateway has already populated actualCostMicroUsd on
      // the result). costSource is "priced" only when authoritative DB pricing
      // was available, else "unconfigured" (tokens recorded, cost not charged).
      let credentialDailyReservationKey: string | null = null;
      let costStatus: "priced" | "unconfigured" | "unattributed" | null = null;
      if (r.credentialDailyReservationKey) {
        const priced = snapshot.pricing.inputPriceUsdPerMillion !== null
          || snapshot.pricing.outputPriceUsdPerMillion !== null;
        costStatus = priced ? "priced" : "unconfigured";
        try {
          this.repos.aiCredentialDailyUsage.settle({
            reservationKey: r.credentialDailyReservationKey,
            inputTokens: r.inputTokens ?? 0,
            cachedInputTokens: r.cachedInputTokens ?? 0,
            outputTokens: r.outputTokens ?? 0,
            reasoningTokens: r.thinkingTokens ?? 0,
            totalTokens: r.totalTokens ?? 0,
            actualCostMicroUsd: r.actualCostMicroUsd ?? r.estimatedCostMicroUsd ?? 0,
            costSource: costStatus
          });
          credentialDailyReservationKey = r.credentialDailyReservationKey;
        } catch {
          // A failed settle must not block the usage log. The reservation will
          // be recovered by the stale-pending sweep on the next reserve.
        }
      } else if (r.credentialId === undefined || r.credentialId === null) {
        costStatus = "unattributed";
      }

      this.repos.aiUsageLogs.create({
        requestId: entry.requestId,
        provider: r.provider,
        credentialId: r.credentialId ?? null,
        model: r.model,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        totalTokens: r.totalTokens ?? null,
        // Q&A detail (spec §2): redacted + bounded.
        questionText: redactSensitiveText(entry.question, 10_000),
        answerText: r.answer ? redactSensitiveText(r.answer, MAX_ANSWER_CHARS) : null,
        // Token breakdown (spec §6): cached/thinking are subsets of totals.
        cachedInputTokens: r.cachedInputTokens ?? null,
        thinkingTokens: r.thinkingTokens ?? null,
        // Cost breakdown (spec §6): the settled per-component integers.
        inputCostMicrousd: breakdown?.inputCostMicroUsd ?? 0,
        cachedInputCostMicrousd: breakdown?.cachedInputCostMicroUsd ?? 0,
        outputCostMicrousd: breakdown?.outputCostMicroUsd ?? 0,
        totalCostMicrousd: breakdown?.totalCostMicroUsd ?? 0,
        // Pricing provenance (spec §5.3): immutable snapshot per request.
        pricingSource,
        pricingVersion: r.pricingVersion ?? snapshot.pricingVersion,
        pricingSnapshotJson: serializePricingSnapshot(snapshot),
        usageSource,
        // Legacy aggregate cost columns retained for back-compat.
        estimatedCostMicroUsd: r.estimatedCostMicroUsd ?? 0,
        actualCostMicroUsd: r.actualCostMicroUsd ?? r.estimatedCostMicroUsd ?? 0,
        finishReason: r.finishReason ?? null,
        // OpenAI Credential daily ledger provenance.
        credentialDailyReservationKey,
        usageAttempt: null,
        costStatus,
        // Token Pool provenance (spec §6): sourced from the composite reservation
        // ledger, never guessed from pricing config. Query the most recent settled
        // reservation for this request to attribute pool/logicalModel/overage.
        ...this.poolProvenance(entry.requestId, usageSource)
      });
    }
  }

  /**
   * Attribute Token Pool provenance for a usage log row by reading the most
   * recent settled reservation for the request from the ledger. Returns empty
   * fields when no pool reservation exists (passthrough / non-mapped models),
   * so legacy and unmapped-provider usage logs are unaffected.
   *
   * This reads from the reservation ledger rather than guessing from
   * pricingConfig (spec §13). Never returns API keys, credential material, or
   * prompt content — only the pool id, logical model id, estimation flag, and
   * overage token count.
   */
  private poolProvenance(
    requestId: string,
    usageSource: "provider_response" | "system_estimated"
  ): { poolId: string | null; logicalModelId: string | null; estimated: boolean | null; overageTokens: number | null } {
    // The composite reservation settles under requestId OR `${requestId}:verify`
    // (verification passes). Check the primary first.
    const settled = this.repos.aiTokenPoolReservations.findSettledByRequest(requestId);
    const latest = settled[settled.length - 1];
    if (!latest) {
      return { poolId: null, logicalModelId: null, estimated: null, overageTokens: null };
    }
    return {
      poolId: latest.poolId,
      logicalModelId: latest.logicalModelId,
      estimated: usageSource === "system_estimated",
      overageTokens: latest.overage ? Math.max(0, (latest.actualTokens ?? 0) - latest.estimatedTokens) : 0
    };
  }
}
