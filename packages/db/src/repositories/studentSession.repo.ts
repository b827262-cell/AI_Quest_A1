import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../client";
import { studentSessions } from "../schema";
import { newId, nowIso } from "./util";

export function makeStudentSessionRepo(db: Db) {
  return {
    create(input: { tokenDigest: string; userId: string; expiresAt: string; ipAddress?: string | null; userAgent?: string | null }) {
      const now = nowIso();
      const id = newId("sts");
      db.insert(studentSessions).values({
        id,
        tokenDigest: input.tokenDigest,
        userId: input.userId,
        createdAt: now,
        expiresAt: input.expiresAt,
        lastSeenAt: now,
        revokedAt: null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null
      }).run();
      return this.findById(id)!;
    },
    findById(id: string) {
      return db.select().from(studentSessions).where(eq(studentSessions.id, id)).get();
    },
    findActiveByTokenDigest(tokenDigest: string, now = nowIso()) {
      const row = db.select().from(studentSessions).where(and(
        eq(studentSessions.tokenDigest, tokenDigest),
        isNull(studentSessions.revokedAt)
      )).get();
      if (!row) return undefined;
      if (row.expiresAt <= now) {
        db.update(studentSessions).set({ revokedAt: now }).where(eq(studentSessions.id, row.id)).run();
        return undefined;
      }
      db.update(studentSessions).set({ lastSeenAt: now }).where(eq(studentSessions.id, row.id)).run();
      return { ...row, lastSeenAt: now };
    },
    revokeById(id: string, at = nowIso()) {
      return db.update(studentSessions).set({ revokedAt: at })
        .where(and(eq(studentSessions.id, id), isNull(studentSessions.revokedAt))).run().changes > 0;
    },
    revokeByTokenDigest(tokenDigest: string, at = nowIso()) {
      return db.update(studentSessions).set({ revokedAt: at })
        .where(and(eq(studentSessions.tokenDigest, tokenDigest), isNull(studentSessions.revokedAt))).run().changes > 0;
    },
    purgeExpired(now = nowIso()) {
      return db.update(studentSessions).set({ revokedAt: now })
        .where(and(lt(studentSessions.expiresAt, now), isNull(studentSessions.revokedAt))).run().changes;
    }
  };
}

export type StudentSessionRepo = ReturnType<typeof makeStudentSessionRepo>;
