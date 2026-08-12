import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../client";
import { studentOAuthStates } from "../schema";
import { newId, nowIso } from "./util";

export function makeStudentOAuthStateRepo(db: Db) {
  return {
    create(input: { stateDigest: string; verifierCiphertext: string; returnTo: string; expiresAt: string }) {
      db.insert(studentOAuthStates).values({
        id: newId("sos"),
        stateDigest: input.stateDigest,
        verifierCiphertext: input.verifierCiphertext,
        returnTo: input.returnTo,
        createdAt: nowIso(),
        expiresAt: input.expiresAt,
        consumedAt: null
      }).run();
    },
    consume(stateDigest: string, now = nowIso()) {
      const row = db.select().from(studentOAuthStates).where(and(
        eq(studentOAuthStates.stateDigest, stateDigest),
        isNull(studentOAuthStates.consumedAt)
      )).get();
      if (!row || row.expiresAt <= now) return undefined;
      const changed = db.update(studentOAuthStates).set({ consumedAt: now }).where(and(
        eq(studentOAuthStates.id, row.id),
        isNull(studentOAuthStates.consumedAt)
      )).run().changes;
      return changed === 1 ? { verifierCiphertext: row.verifierCiphertext, returnTo: row.returnTo } : undefined;
    },
    purgeExpired(now = nowIso()) {
      return db.update(studentOAuthStates).set({ consumedAt: now }).where(and(
        lt(studentOAuthStates.expiresAt, now),
        isNull(studentOAuthStates.consumedAt)
      )).run().changes;
    }
  };
}

export type StudentOAuthStateRepo = ReturnType<typeof makeStudentOAuthStateRepo>;
