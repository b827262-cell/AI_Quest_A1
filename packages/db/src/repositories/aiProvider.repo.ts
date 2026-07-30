import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import { aiAdminAuditLogs, aiCredentialModelQuotas, aiProviderConfigs, aiProviderCredentials } from "../schema";
import { assertQuotaTimezone, initialQuotaPeriods } from "./aiCredentialModelQuota.repo";
import { newId, nowIso } from "./util";

export type ProviderId = "openai" | "gemini" | "kimi" | "qwen" | "zai";
export type CredentialStatus = "active" | "standby" | "disabled";

export type ProviderConfigInput = {
  id?: string;
  provider: ProviderId;
  slug?: string;
  displayName: string;
  baseUrl?: string | null;
  model?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  isRouterProvider?: boolean;
  priority?: number;
};

export class AiProviderIdentityConflictError extends Error {
  readonly code = "provider_identity_conflict" as const;
  constructor(readonly field: "slug" | "displayName") {
    super(`provider ${field} already exists`);
    this.name = "AiProviderIdentityConflictError";
  }
}

const providerIds = new Set<ProviderId>(["openai", "gemini", "kimi", "qwen", "zai"]);
const auditMetadataKeys = new Set([
  "provider", "status", "result", "lastActiveCredential", "credentialCount", "dryRun",
  // Token Pool provenance (spec §6): pool type + logical model id only, never keys.
  "poolType", "logicalModelId", "dailyLimit", "contextWindowTokens",
  "validationReason", "httpStatus", "region", "health", "billingMode", "usageScope",
  "datasetId", "datasetVersion", "executionMode", "runId", "status"
]);

function safeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(metadata)].filter(([key, value]) =>
    auditMetadataKeys.has(key)
      && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
  ));
}

export function slugForProviderInstance(displayName: string): string {
  const slug = displayName
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (slug) return slug;
  let hash = 2_166_136_261;
  for (const character of displayName.normalize("NFKC").trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `provider-${(hash >>> 0).toString(36)}`;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function makeAiProviderRepo(db: Db) {
  const listConfigs = () => db.select().from(aiProviderConfigs)
    .where(isNull(aiProviderConfigs.deletedAt)).orderBy(asc(aiProviderConfigs.priority)).all();
  const allConfigs = () => db.select().from(aiProviderConfigs).all();
  const findConfigByIdentity = (input: { slug: string; displayName: string; includeDeleted: boolean; excludeId?: string }) => {
    const slug = normalizeIdentity(input.slug);
    const displayName = normalizeIdentity(input.displayName);
    return allConfigs().find((row) =>
      row.id !== input.excludeId
      && (input.includeDeleted || !row.deletedAt)
      && (normalizeIdentity(row.slug) === slug || normalizeIdentity(row.displayName) === displayName)
    );
  };
  const findIdentityConflict = (input: { slug: string; displayName: string; excludeId?: string }) => {
    const rows = allConfigs().filter((row) => row.id !== input.excludeId);
    if (rows.some((row) => normalizeIdentity(row.slug) === normalizeIdentity(input.slug))) {
      throw new AiProviderIdentityConflictError("slug");
    }
    if (rows.some((row) => normalizeIdentity(row.displayName) === normalizeIdentity(input.displayName))) {
      throw new AiProviderIdentityConflictError("displayName");
    }
  };
  return {
    listConfigs,
    findConfig(id: string) {
      return db.select().from(aiProviderConfigs).where(and(eq(aiProviderConfigs.id, id), isNull(aiProviderConfigs.deletedAt))).get();
    },
    findConfigIncludingDeleted(id: string) {
      return db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.id, id)).get();
    },
    findConfigBySlug(slug: string, includeDeleted = false) {
      return allConfigs().find((row) => (includeDeleted || !row.deletedAt) && normalizeIdentity(row.slug) === normalizeIdentity(slug));
    },
    findConfigByDisplayName(displayName: string, includeDeleted = false) {
      return allConfigs().find((row) => (includeDeleted || !row.deletedAt) && normalizeIdentity(row.displayName) === normalizeIdentity(displayName));
    },
    findConfigByProvider(provider: ProviderId) {
      // Compatibility lookup for adapter-only callers. New associations must
      // carry the provider config id; this returns the first configured
      // instance only when no instance id is available.
      const matches = listConfigs().filter((row) => normalizeIdentity(row.provider) === normalizeIdentity(provider));
      return matches.find((row) => row.isRouterProvider || row.isDefault) ?? matches[0];
    },
    findConfigByProviderIncludingDeleted(provider: ProviderId) {
      const matches = allConfigs().filter((row) => normalizeIdentity(row.provider) === normalizeIdentity(provider));
      return matches.find((row) => row.isRouterProvider || row.isDefault) ?? matches[0];
    },
    upsertConfig(input: ProviderConfigInput) {
      if (!providerIds.has(input.provider)) throw new Error("invalid provider");
      const currentById = input.id ? this.findConfig(input.id) : undefined;
      const requestedSlug = input.slug?.trim().toLowerCase() || currentById?.slug || slugForProviderInstance(input.displayName);
      const current = currentById
        ?? findConfigByIdentity({ slug: requestedSlug, displayName: input.displayName, includeDeleted: false });
      if (!current) return this.createConfig({ ...input, slug: requestedSlug }).row;
      findIdentityConflict({ slug: requestedSlug || current.slug, displayName: input.displayName, excludeId: current.id });
      const now = nowIso();
      // A deployment has one effective default and one effective router
      // provider. Clear the old flag before assigning the new one; this keeps
      // the selection deterministic even when the admin changes providers.
      if (input.isDefault === true) {
        for (const row of listConfigs()) {
          if (row.isDefault && row.id !== current?.id) {
            db.update(aiProviderConfigs).set({ isDefault: false, updatedAt: now })
              .where(eq(aiProviderConfigs.id, row.id)).run();
          }
        }
      }
      if (input.isRouterProvider === true) {
        for (const row of listConfigs()) {
          if (row.isRouterProvider && row.id !== current?.id) {
            db.update(aiProviderConfigs).set({ isRouterProvider: false, updatedAt: now })
              .where(eq(aiProviderConfigs.id, row.id)).run();
          }
        }
      }
      db.update(aiProviderConfigs).set({
        slug: requestedSlug || current.slug, displayName: input.displayName, baseUrl: input.baseUrl ?? null, model: input.model ?? null,
        enabled: input.enabled ?? current.enabled, isDefault: input.isDefault ?? current.isDefault,
        isRouterProvider: input.isRouterProvider ?? current.isRouterProvider,
        priority: input.priority ?? current.priority, updatedAt: now
      }).where(eq(aiProviderConfigs.id, current.id)).run();
      return this.findConfig(current.id)!;
    },
    /** POST-only create semantics. Adapter types may be shared by instances. */
    createConfig(input: ProviderConfigInput) {
      if (!providerIds.has(input.provider)) throw new Error("invalid provider");
      const slug = input.slug?.trim().toLowerCase() || slugForProviderInstance(input.displayName);
      const active = findConfigByIdentity({ slug, displayName: input.displayName, includeDeleted: false });
      if (active) {
        throw new AiProviderIdentityConflictError(normalizeIdentity(active.slug) === normalizeIdentity(slug) ? "slug" : "displayName");
      }
      const deleted = findConfigByIdentity({ slug, displayName: input.displayName, includeDeleted: true });
      findIdentityConflict({ slug, displayName: input.displayName, excludeId: deleted?.id });
      const now = nowIso();
      const clearRoles = (currentId?: string) => {
        if (input.isDefault === true) {
          for (const row of listConfigs()) {
            if (row.isDefault && row.id !== currentId) {
              db.update(aiProviderConfigs).set({ isDefault: false, updatedAt: now })
                .where(eq(aiProviderConfigs.id, row.id)).run();
            }
          }
        }
        if (input.isRouterProvider === true) {
          for (const row of listConfigs()) {
            if (row.isRouterProvider && row.id !== currentId) {
              db.update(aiProviderConfigs).set({ isRouterProvider: false, updatedAt: now })
                .where(eq(aiProviderConfigs.id, row.id)).run();
            }
          }
        }
      };
      if (deleted) {
        clearRoles(deleted.id);
        db.transaction((tx) => {
          tx.update(aiProviderConfigs).set({
            provider: input.provider,
            slug,
            displayName: input.displayName,
            baseUrl: input.baseUrl ?? null,
            model: input.model ?? null,
            enabled: input.enabled ?? true,
            isDefault: input.isDefault ?? false,
            isRouterProvider: input.isRouterProvider ?? false,
            priority: input.priority ?? 100,
            deletedAt: null,
            updatedAt: now
          }).where(eq(aiProviderConfigs.id, deleted.id)).run();
        });
        return { row: this.findConfig(deleted.id)!, restored: true };
      }
      clearRoles();
      const id = newId("aip");
      db.insert(aiProviderConfigs).values({
        id,
        provider: input.provider,
        slug,
        displayName: input.displayName,
        baseUrl: input.baseUrl ?? null,
        model: input.model ?? null,
        enabled: input.enabled ?? true,
        isDefault: input.isDefault ?? false,
        isRouterProvider: input.isRouterProvider ?? false,
        priority: input.priority ?? 100,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }).run();
      return { row: this.findConfig(id)!, restored: false };
    },
    /** Soft-delete a provider and synchronously disable its credential graph. */
    deleteConfig(id: string) {
      const current = this.findConfigIncludingDeleted(id);
      if (!current) return { deleted: false, alreadyDeleted: false, notFound: true, credentialCount: 0 };
      if (current.deletedAt) return { deleted: false, alreadyDeleted: true, notFound: false, credentialCount: 0 };
      if (current.isRouterProvider) throw new Error("default router cannot be deleted");
      const credentials = this.listCredentials(id, true);
      const now = nowIso();
      db.transaction((tx) => {
        tx.update(aiProviderConfigs).set({
          enabled: false,
          deletedAt: now,
          updatedAt: now
        }).where(eq(aiProviderConfigs.id, id)).run();
        tx.update(aiProviderCredentials).set({
          status: "disabled",
          disabledAt: now,
          updatedAt: now
        }).where(eq(aiProviderCredentials.providerConfigId, id)).run();
        for (const credential of credentials) {
          tx.update(aiCredentialModelQuotas).set({ enabled: false, updatedAt: now })
            .where(eq(aiCredentialModelQuotas.credentialId, credential.id)).run();
        }
      });
      this.audit("provider.deleted", "ai_provider", id, {
        provider: current.provider,
        status: "disabled",
        result: "soft_deleted",
        credentialCount: credentials.length
      });
      return { deleted: true, alreadyDeleted: false, notFound: false, credentialCount: credentials.length };
    },
    listCredentials(providerConfigId: string, includeDeleted = false) {
      const where = includeDeleted ? eq(aiProviderCredentials.providerConfigId, providerConfigId) : and(eq(aiProviderCredentials.providerConfigId, providerConfigId), isNull(aiProviderCredentials.deletedAt));
      return db.select().from(aiProviderCredentials).where(where).orderBy(asc(aiProviderCredentials.priority), asc(aiProviderCredentials.createdAt)).all();
    },
    findCredential(id: string) {
      return db.select().from(aiProviderCredentials).where(and(eq(aiProviderCredentials.id, id), isNull(aiProviderCredentials.deletedAt))).get();
    },
    findCredentialIncludingDeleted(id: string) {
      return db.select().from(aiProviderCredentials).where(eq(aiProviderCredentials.id, id)).get();
    },
    findCredentialByName(providerConfigId: string, name: string, excludeId?: string) {
      return this.listCredentials(providerConfigId).find((row) =>
        row.id !== excludeId && row.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      );
    },
    findByFingerprint(fingerprint: string) {
      return db.select().from(aiProviderCredentials).where(eq(aiProviderCredentials.keyFingerprint, fingerprint)).get();
    },
    createCredential(input: { providerConfigId: string; name: string; encryptedApiKey: string; maskedApiKey: string; keyFingerprint: string; baseUrl?: string | null; model?: string | null; rpmLimit?: number | null; tpmLimit?: number | null; rpdLimit?: number | null; resetTimezone?: string; status?: CredentialStatus; billingMode?: string; region?: string; endpointProfile?: string; usageScope?: string; productionAuthorized?: boolean; allowEvaluation?: boolean; evaluationAuthorizedAt?: string | null; evaluationAuthorizedByAdminId?: string | null; priority?: number; weight?: number }) {
      const now = nowIso(); const id = newId("aic");
      const model = input.model?.trim() || null;
      const timezone = assertQuotaTimezone(input.resetTimezone ?? "Asia/Taipei");
      const periods = initialQuotaPeriods(new Date(now), timezone);
      db.transaction((tx) => {
        tx.insert(aiProviderCredentials).values({ id, providerConfigId: input.providerConfigId, name: input.name,
          encryptedApiKey: input.encryptedApiKey, maskedApiKey: input.maskedApiKey, keyFingerprint: input.keyFingerprint,
          baseUrl: input.baseUrl ?? null, model, status: input.status ?? "active", priority: input.priority ?? 100,
          weight: input.weight ?? 1, failureCount: 0, cooldownUntil: null, lastTestedAt: null, lastTestStatus: null,
          lastTestLatencyMs: null, billingMode: input.billingMode ?? "unknown", region: input.region ?? null,
          endpointProfile: input.endpointProfile ?? null, usageScope: input.usageScope ?? "unknown",
          productionAuthorized: input.productionAuthorized ?? false, providerHealth: "unknown",
          allowEvaluation: input.allowEvaluation ?? false,
          evaluationAuthorizedAt: input.evaluationAuthorizedAt ?? null,
          evaluationAuthorizedByAdminId: input.evaluationAuthorizedByAdminId ?? null,
          createdAt: now, updatedAt: now, disabledAt: null, deletedAt: null }).run();
        // A credential's first model is necessarily its enabled default. The
        // quota row is created in the same transaction as the credential.
        if (model) {
          tx.insert(aiCredentialModelQuotas).values({
            id: newId("aiq"), credentialId: id, model,
            rpmLimit: input.rpmLimit ?? null, tpmLimit: input.tpmLimit ?? null, rpdLimit: input.rpdLimit ?? null,
            requestsThisMinute: 0, tokensThisMinute: 0, requestsToday: 0,
            minuteResetAt: periods.minuteResetAt, dailyResetAt: periods.dailyResetAt,
            resetTimezone: timezone, usageSource: "system_estimated", enabled: true, isDefault: true,
            createdAt: now, updatedAt: now
          }).run();
        }
      });
      return this.findCredential(id)!;
    },
    updateCredential(id: string, patch: Partial<{ name: string; encryptedApiKey: string; maskedApiKey: string; keyFingerprint: string; baseUrl: string | null; model: string | null; status: CredentialStatus; billingMode: string; region: string | null; endpointProfile: string | null; usageScope: string; productionAuthorized: boolean; providerHealth: string; allowEvaluation: boolean; evaluationAuthorizedAt: string | null; evaluationAuthorizedByAdminId: string | null; priority: number; weight: number; failureCount: number; cooldownUntil: string | null; lastTestedAt: string | null; lastTestStatus: string | null; lastTestLatencyMs: number | null; disabledAt: string | null; deletedAt: string | null }>) {
      const current = this.findCredential(id);
      if (!current) return undefined;
      const model = patch.model?.trim();
      if (patch.model !== undefined && model) {
        const now = nowIso();
        const existingQuota = db.select().from(aiCredentialModelQuotas)
          .where(eq(aiCredentialModelQuotas.credentialId, id)).all()
          .find((row) => row.model.toLocaleLowerCase() === model!.toLocaleLowerCase());
        const periods = initialQuotaPeriods(new Date(now), "Asia/Taipei");
        db.transaction((tx) => {
          tx.update(aiProviderCredentials).set({ ...patch, model, updatedAt: now }).where(eq(aiProviderCredentials.id, id)).run();
          tx.update(aiCredentialModelQuotas).set({ isDefault: false, updatedAt: now })
            .where(eq(aiCredentialModelQuotas.credentialId, id)).run();
          if (existingQuota) {
            tx.update(aiCredentialModelQuotas).set({ model, enabled: true, isDefault: true, updatedAt: now })
              .where(eq(aiCredentialModelQuotas.id, existingQuota.id)).run();
          } else {
            tx.insert(aiCredentialModelQuotas).values({
              id: newId("aiq"), credentialId: id, model,
              rpmLimit: null, tpmLimit: null, rpdLimit: null,
              requestsThisMinute: 0, tokensThisMinute: 0, requestsToday: 0,
              minuteResetAt: periods.minuteResetAt, dailyResetAt: periods.dailyResetAt,
              resetTimezone: "Asia/Taipei", usageSource: "system_estimated", enabled: true, isDefault: true,
              createdAt: now, updatedAt: now
            }).run();
          }
        });
      } else {
        // Clearing the legacy field must not clear the canonical default model.
        const safePatch = patch.model === null && this.findDefaultQuota(id) ? { ...patch, model: undefined } : patch;
        db.update(aiProviderCredentials).set({ ...safePatch, updatedAt: nowIso() }).where(eq(aiProviderCredentials.id, id)).run();
      }
      return this.findCredential(id);
    },
    findDefaultQuota(credentialId: string) {
      return db.select().from(aiCredentialModelQuotas)
        .where(eq(aiCredentialModelQuotas.credentialId, credentialId)).all()
        .find((row) => row.enabled && row.isDefault);
    },
    // SQLite's null comparison needs a separate query for eligible credentials.
    eligibleCredentials(providerConfigId: string, status: "active" | "standby") {
      const now = nowIso();
      return this.listCredentials(providerConfigId).filter((row) => row.status === status && (!row.cooldownUntil || row.cooldownUntil <= now));
    },
    markCredentialFailure(id: string, cooldownMs: number, health?: string, disable = false) {
      const row = this.findCredential(id); if (!row) return;
      const failureCount = row.failureCount + 1;
      db.update(aiProviderCredentials).set({
        failureCount,
        cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
        ...(health ? { providerHealth: health } : {}),
        ...(disable ? { status: "disabled" as const, disabledAt: nowIso() } : {}),
        updatedAt: nowIso()
      }).where(eq(aiProviderCredentials.id, id)).run();
    },
    markCredentialSuccess(id: string) {
      db.update(aiProviderCredentials).set({ failureCount: 0, cooldownUntil: null, providerHealth: "healthy", updatedAt: nowIso() }).where(eq(aiProviderCredentials.id, id)).run();
    },
    recordTest(id: string, status: "success" | "failed", latencyMs: number) {
      db.update(aiProviderCredentials).set({ lastTestedAt: nowIso(), lastTestStatus: status, lastTestLatencyMs: latencyMs, updatedAt: nowIso() }).where(eq(aiProviderCredentials.id, id)).run();
    },
    audit(action: string, targetType: string, targetId?: string, metadata: Record<string, unknown> = {}) {
      db.insert(aiAdminAuditLogs).values({ id: newId("aia"), action, targetType, targetId: targetId ?? null, metadataJson: JSON.stringify(safeAuditMetadata(metadata)), createdAt: nowIso() }).run();
    }
  };
}
export type AiProviderRepo = ReturnType<typeof makeAiProviderRepo>;
