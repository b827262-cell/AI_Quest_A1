import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client";
import { studentPasscodes, studentSessions, studentUsers } from "../schema";
import { newId, nowIso } from "./util";

export function makeStudentPasscodeRepo(db: Db) {
  return {
    create(input: { email: string; passcodeHash: string; note?: string | null }) {
      const now = nowIso();
      const id = newId("spc");
      db.insert(studentPasscodes).values({ id, email: input.email.trim().toLowerCase(), passcodeHash: input.passcodeHash,
        status: "active", note: input.note ?? null, createdAt: now, updatedAt: now }).run();
      return this.findById(id)!;
    },
    listAdmin() {
      return db.select({ id: studentPasscodes.id, email: studentPasscodes.email, status: studentPasscodes.status,
        note: studentPasscodes.note, createdAt: studentPasscodes.createdAt, updatedAt: studentPasscodes.updatedAt,
        lastUsedAt: studentPasscodes.lastUsedAt }).from(studentPasscodes).all();
    },
    findById(id: string) { return db.select().from(studentPasscodes).where(eq(studentPasscodes.id, id)).get(); },
    findActiveByEmail(email: string) {
      return db.select().from(studentPasscodes).where(and(eq(studentPasscodes.email, email.trim().toLowerCase()),
        eq(studentPasscodes.status, "active"))).get();
    },
    setStatus(id: string, status: "active" | "disabled") {
      db.update(studentPasscodes).set({ status, updatedAt: nowIso() }).where(eq(studentPasscodes.id, id)).run();
      return this.findById(id);
    },
    replaceHash(id: string, passcodeHash: string) {
      db.update(studentPasscodes).set({ passcodeHash, updatedAt: nowIso() }).where(eq(studentPasscodes.id, id)).run();
      return this.findById(id);
    },
    withActiveCredential<T>(email: string, hash: string, operation: () => T): T | undefined {
      return db.transaction((tx) => {
        const current = tx.select().from(studentPasscodes).where(and(
          eq(studentPasscodes.email, email.trim().toLowerCase()), eq(studentPasscodes.status, "active")
        )).get();
        if (!current || current.passcodeHash !== hash) return undefined;
        return operation();
      }, { behavior: "immediate" });
    },
    changeAndRevoke(id: string, change: { status?: "active" | "disabled"; passcodeHash?: string }) {
      return db.transaction((tx) => {
        const existing = tx.select().from(studentPasscodes).where(eq(studentPasscodes.id, id)).get();
        if (!existing) return false;
        tx.update(studentPasscodes).set({ ...change, updatedAt: nowIso() }).where(eq(studentPasscodes.id, id)).run();
        if (change.status === "disabled" || change.passcodeHash !== undefined) {
          const users = tx.select({ id: studentUsers.id }).from(studentUsers)
            .where(sql`lower(trim(${studentUsers.email})) = ${existing.email}`).all();
          for (const user of users) tx.update(studentSessions).set({ revokedAt: nowIso() })
            .where(and(eq(studentSessions.userId, user.id), isNull(studentSessions.revokedAt))).run();
        }
        return true;
      }, { behavior: "immediate" });
    },
    touchUsed(id: string) {
      db.update(studentPasscodes).set({ lastUsedAt: nowIso() }).where(eq(studentPasscodes.id, id)).run();
    }
  };
}
export type StudentPasscodeRepo = ReturnType<typeof makeStudentPasscodeRepo>;
