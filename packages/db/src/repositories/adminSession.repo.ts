import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../client";
import { adminSessions } from "../schema";
import { newId, nowIso } from "./util";

export function makeAdminSessionRepo(db: Db) {
  return {
    create(input: {
      tokenDigest: string;
      csrfTokenDigest: string;
      username: string;
      expiresAt: string;
      ipAddress?: string | null;
      userAgent?: string | null;
    }) {
      const now = nowIso();
      const id = newId("ads");
      db.insert(adminSessions).values({
        id,
        tokenDigest: input.tokenDigest,
        csrfTokenDigest: input.csrfTokenDigest,
        username: input.username,
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
      return db.select().from(adminSessions).where(eq(adminSessions.id, id)).get();
    },
    findActiveByTokenDigest(tokenDigest: string, now = nowIso()) {
      const row = db.select().from(adminSessions).where(and(
        eq(adminSessions.tokenDigest, tokenDigest),
        isNull(adminSessions.revokedAt)
      )).get();
      if (!row) return undefined;
      if (row.expiresAt <= now) {
        db.update(adminSessions).set({ revokedAt: now }).where(eq(adminSessions.id, row.id)).run();
        return undefined;
      }
      db.update(adminSessions).set({ lastSeenAt: now }).where(eq(adminSessions.id, row.id)).run();
      return { ...row, lastSeenAt: now };
    },
    verifyCsrfToken(id: string, csrfTokenDigest: string) {
      return Boolean(db.select({ id: adminSessions.id }).from(adminSessions).where(and(
        eq(adminSessions.id, id),
        eq(adminSessions.csrfTokenDigest, csrfTokenDigest),
        isNull(adminSessions.revokedAt)
      )).get());
    },
    revokeByTokenDigest(tokenDigest: string, at = nowIso()) {
      return db.update(adminSessions).set({ revokedAt: at })
        .where(and(eq(adminSessions.tokenDigest, tokenDigest), isNull(adminSessions.revokedAt))).run().changes > 0;
    },
    revokeById(id: string, at = nowIso()) {
      return db.update(adminSessions).set({ revokedAt: at })
        .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt))).run().changes > 0;
    },
    revokeAllForUsername(username: string, at = nowIso()) {
      return db.update(adminSessions).set({ revokedAt: at })
        .where(and(eq(adminSessions.username, username), isNull(adminSessions.revokedAt))).run().changes;
    },
    purgeExpired(now = nowIso()) {
      return db.update(adminSessions).set({ revokedAt: now })
        .where(and(lt(adminSessions.expiresAt, now), isNull(adminSessions.revokedAt))).run().changes;
    }
  };
}

export type AdminSessionRepo = ReturnType<typeof makeAdminSessionRepo>;
