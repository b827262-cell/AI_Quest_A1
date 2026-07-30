import { and, eq } from "drizzle-orm";
import type {
  AiBudgetScopeType,
  CreateAiBudgetPolicyInput,
  UpdateAiBudgetPolicyInput
} from "@ai-smartbook/schema";
import type { Db } from "../client";
import { aiBudgetPolicies } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiBudgetPolicies.$inferSelect;

/**
 * Convert the schema-level USD value to the stored micro-USD integer.
 * (The schema exposes USD for ergonomic editing; storage is integer micro-USD.)
 */
function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function makeAiBudgetPolicyRepo(db: Db) {
  return {
    list(): Row[] {
      return db.select().from(aiBudgetPolicies).all();
    },

    findByScope(scopeType: AiBudgetScopeType, scopeKey: string): Row | undefined {
      return db
        .select()
        .from(aiBudgetPolicies)
        .where(
          and(eq(aiBudgetPolicies.scopeType, scopeType), eq(aiBudgetPolicies.scopeKey, scopeKey))
        )
        .get();
    },

    upsertByScope(input: CreateAiBudgetPolicyInput): Row {
      const ts = nowIso();
      const existing = this.findByScope(input.scopeType, input.scopeKey);
      if (existing) {
        db.update(aiBudgetPolicies)
          .set({
            dailyTokenLimit: input.dailyTokenLimit,
            dailyCostLimitMicroUsd: usdToMicro(input.dailyCostLimitUsd),
            warningPercentage: Math.round(input.warningPercentage),
            enabled: input.enabled,
            updatedAt: ts
          })
          .where(eq(aiBudgetPolicies.id, existing.id))
          .run();
        return this.findByScope(input.scopeType, input.scopeKey)!;
      }
      const row: Row = {
        id: newId("aib"),
        scopeType: input.scopeType,
        scopeKey: input.scopeKey,
        dailyTokenLimit: input.dailyTokenLimit,
        dailyCostLimitMicroUsd: usdToMicro(input.dailyCostLimitUsd),
        warningPercentage: Math.round(input.warningPercentage),
        enabled: input.enabled,
        createdAt: ts,
        updatedAt: ts
      };
      db.insert(aiBudgetPolicies).values(row).run();
      return row;
    },

    update(id: string, input: UpdateAiBudgetPolicyInput): Row | undefined {
      const existing = db.select().from(aiBudgetPolicies).where(eq(aiBudgetPolicies.id, id)).get();
      if (!existing) return undefined;
      const patch: Partial<Row> = { updatedAt: nowIso() };
      if (input.dailyTokenLimit !== undefined) patch.dailyTokenLimit = input.dailyTokenLimit;
      if (input.dailyCostLimitUsd !== undefined)
        patch.dailyCostLimitMicroUsd = usdToMicro(input.dailyCostLimitUsd);
      if (input.warningPercentage !== undefined)
        patch.warningPercentage = Math.round(input.warningPercentage);
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      db.update(aiBudgetPolicies).set(patch).where(eq(aiBudgetPolicies.id, id)).run();
      return db.select().from(aiBudgetPolicies).where(eq(aiBudgetPolicies.id, id)).get();
    },

    /** Ensure a sensible default global policy exists (idempotent). */
    ensureDefaultGlobals(defaults: {
      dailyTokenLimit: number;
      dailyCostLimitUsd: number;
      warningPercentage: number;
    }): void {
      const existing = this.findByScope("global", "default");
      if (existing) return;
      this.upsertByScope({
        scopeType: "global",
        scopeKey: "default",
        dailyTokenLimit: defaults.dailyTokenLimit,
        dailyCostLimitUsd: defaults.dailyCostLimitUsd,
        warningPercentage: defaults.warningPercentage,
        enabled: true
      });
    }
  };
}

export type AiBudgetPolicyRepo = ReturnType<typeof makeAiBudgetPolicyRepo>;
