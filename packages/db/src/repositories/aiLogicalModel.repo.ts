import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiLogicalModels } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiLogicalModels.$inferSelect;

/**
 * Logical Model Registry repository.
 *
 * Quota accounting uses `logicalModelId`; the provider call uses
 * `providerModelName`. The Context Window columns describe single-request
 * capacity (dimension 4) and are deliberately independent of the per-day
 * daily limit stored on aiModelDailyLimits.
 */
export function makeAiLogicalModelRepo(db: Db) {
  return {
    list(): Row[] {
      return db.select().from(aiLogicalModels).all();
    },

    findById(id: string): Row | undefined {
      return db.select().from(aiLogicalModels).where(eq(aiLogicalModels.id, id)).get();
    },

    findByLogicalId(logicalModelId: string): Row | undefined {
      return db
        .select()
        .from(aiLogicalModels)
        .where(eq(aiLogicalModels.logicalModelId, logicalModelId))
        .get();
    },

    /** Return the single enabled mapping for a logical model id, if any. */
    findEnabled(logicalModelId: string): Row | undefined {
      const row = this.findByLogicalId(logicalModelId);
      return row && row.enabled ? row : undefined;
    },

    upsert(input: {
      logicalModelId: string;
      providerId: string;
      providerConfigId?: string | null;
      providerModelName: string;
      contextWindowTokens: number;
      maxInputTokens?: number | null;
      maxOutputTokens: number;
      supportsThinking?: boolean;
      tokenizerType?: string | null;
      tokenizerVersion?: string | null;
      enabled?: boolean;
    }): Row {
      const ts = nowIso();
      const existing = this.findByLogicalId(input.logicalModelId);
      if (existing) {
        db.update(aiLogicalModels)
          .set({
            providerId: input.providerId,
            providerConfigId: input.providerConfigId ?? null,
            providerModelName: input.providerModelName,
            contextWindowTokens: input.contextWindowTokens,
            maxInputTokens: input.maxInputTokens ?? null,
            maxOutputTokens: input.maxOutputTokens,
            supportsThinking: input.supportsThinking ?? false,
            tokenizerType: input.tokenizerType ?? null,
            tokenizerVersion: input.tokenizerVersion ?? null,
            enabled: input.enabled ?? true,
            updatedAt: ts
          })
          .where(eq(aiLogicalModels.id, existing.id))
          .run();
        return this.findByLogicalId(input.logicalModelId)!;
      }
      const row: Row = {
        id: newId("ailm"),
        logicalModelId: input.logicalModelId,
        providerId: input.providerId,
        providerConfigId: input.providerConfigId ?? null,
        providerModelName: input.providerModelName,
        contextWindowTokens: input.contextWindowTokens,
        maxInputTokens: input.maxInputTokens ?? null,
        maxOutputTokens: input.maxOutputTokens,
        supportsThinking: input.supportsThinking ?? false,
        tokenizerType: input.tokenizerType ?? null,
        tokenizerVersion: input.tokenizerVersion ?? null,
        enabled: input.enabled ?? true,
        createdAt: ts,
        updatedAt: ts
      };
      db.insert(aiLogicalModels).values(row).run();
      return row;
    },

    update(
      logicalModelId: string,
      patch: Partial<{
        providerId: string;
        providerConfigId?: string | null;
        providerModelName: string;
        contextWindowTokens: number;
        maxInputTokens: number | null;
        maxOutputTokens: number;
        supportsThinking: boolean;
        tokenizerType: string | null;
        tokenizerVersion: string | null;
        enabled: boolean;
      }>
    ): Row | undefined {
      const existing = this.findByLogicalId(logicalModelId);
      if (!existing) return undefined;
      db.update(aiLogicalModels)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(aiLogicalModels.id, existing.id))
        .run();
      return this.findByLogicalId(logicalModelId);
    }
  };
}

export type AiLogicalModelRepo = ReturnType<typeof makeAiLogicalModelRepo>;
