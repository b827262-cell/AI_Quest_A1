import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { guestAskAnswers } from "../schema";
import { newId, nowIso } from "./util";

export type GuestAskAnswerStatus = "success" | "incomplete";
export type GuestAskAnswerMode = "live" | "mock";

export type CreateGuestAskAnswerInput = {
  requestId: string;
  /** HMAC-SHA-256(secret, normalizedIp). Quota/risk signal only, not auth. */
  visitorIpHmac: string;
  /** HMAC-SHA-256(secret, recoveryToken). The sole recovery authorization. */
  recoveryTokenDigest: string;
  /** ISO timestamp; recovery is refused once now >= expiresAt. */
  expiresAt: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  mode: GuestAskAnswerMode;
  status: GuestAskAnswerStatus;
  finishReason?: string | null;
  completionJson?: string | null;
};

/** Maximum rows removed per cleanup pass to avoid long-running transactions. */
const CLEANUP_BATCH_SIZE = 500;

export function makeGuestAskAnswerRepo(db: Db) {
  return {
    create(input: CreateGuestAskAnswerInput) {
      const row = {
        id: newId("gqa"),
        requestId: input.requestId,
        // Legacy column kept populated for back-compat; not read for recovery.
        visitorIpHash: input.visitorIpHmac,
        visitorIpHmac: input.visitorIpHmac,
        recoveryTokenDigest: input.recoveryTokenDigest,
        expiresAt: input.expiresAt,
        question: input.question,
        answer: input.answer,
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        status: input.status,
        finishReason: input.finishReason ?? null,
        completionJson: input.completionJson ?? null,
        createdAt: nowIso()
      };
      db.insert(guestAskAnswers).values(row).run();
      return row;
    },

    /**
     * Authoritative recovery lookup. Authorization is answerId + recovery token
     * digest; the row must also be unexpired. Returns undefined for any
     * mismatch, missing token, or expired answer so callers can return a
     * generic 404 without revealing which condition failed.
     */
    findActiveByRequestIdAndTokenDigest(requestId: string, recoveryTokenDigest: string, nowIso: string) {
      return db
        .select()
        .from(guestAskAnswers)
        .where(
          and(
            eq(guestAskAnswers.requestId, requestId),
            eq(guestAskAnswers.recoveryTokenDigest, recoveryTokenDigest),
            sql`${guestAskAnswers.expiresAt} > ${nowIso}`
          )
        )
        .get();
    },

    /**
     * Opportunistic / startup cleanup of expired guest answers. Deletes in
     * bounded batches until no expired rows remain. Returns a safe aggregate
     * statistic (count only — never question/answer/IP/token content).
     */
    cleanupExpired(nowIsoValue: string): { deleted: number } {
      let deleted = 0;
      // Loop in bounded batches to avoid a single long lock/transaction on a
      // large backlog. Each iteration removes at most CLEANUP_BATCH_SIZE rows.
      // Raw SQL is used because the drizzle better-sqlite3 delete builder does
      // not reliably support LIMIT in this version.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = db
          .run(
            sql`DELETE FROM ${guestAskAnswers} WHERE ${guestAskAnswers.expiresAt} <= ${nowIsoValue} LIMIT ${CLEANUP_BATCH_SIZE}`
          );
        const changed = result.changes ?? 0;
        deleted += changed;
        if (changed < CLEANUP_BATCH_SIZE) break;
      }
      return { deleted };
    },

    /** Test/diagnostics helper: count rows (never exposes content). */
    count(): number {
      const row = db
        .get<{ n: number }>(sql`SELECT count(*) AS n FROM ${guestAskAnswers}`);
      return row?.n ?? 0;
    }
  };
}

export type GuestAskAnswerRepo = ReturnType<typeof makeGuestAskAnswerRepo>;
