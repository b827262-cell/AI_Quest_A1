import type { BudgetReservation } from "../gateway/ai-gateway";

/**
 * Composite reservation that carries BOTH the inner (global/source) budget
 * reservation AND the Token Pool reservation, plus the logical-model context
 * needed to attribute usage to the right pool/model.
 *
 * This type is STRUCTURALLY COMPATIBLE with `BudgetReservation` (it includes
 * all 5 of its fields verbatim: id, provider, model, estimatedTokens,
 * estimatedCostMicroUsd). Because `BudgetReservation` is a closed type with no
 * index signature, the composite declares the compatibility fields explicitly
 * and adds the Token Pool fields as a strict superset. The gateway's
 * `settleReservation(reservation: BudgetReservation, ...)` and
 * `releaseReservation(reservation: BudgetReservation)` therefore accept a
 * composite without modification.
 *
 * The pool fields are OPTIONAL so that reservations for providers WITHOUT a
 * logical-model mapping (e.g. gemini, zai, mock) pass through unchanged — they
 * carry only the inner reservation and skip the pool entirely.
 */
export interface CompositeBudgetReservation extends BudgetReservation {
  /** The inner global/source budget reservation, if the inner manager reserved. */
  innerReservation?: BudgetReservation;
  /** Token Pool reservation ledger id (NULL when the model has no pool config). */
  poolReservationId?: string;
  /** Pool the reservation counted against. */
  poolId?: string;
  /** Logical model id used for quota accounting (NULL for passthrough models). */
  logicalModelId?: string;
  /** Composite idempotency key echoed from the reservation ledger. */
  reservationKey: string;
  /** Per-attempt id distinguishing fallback attempts under the same request. */
  attemptId: string;
  /** Current ledger status; settled/released reservations are idempotent noops. */
  status: "pending" | "settled" | "released";
}

/**
 * Build a composite reservation. When the model has no pool config, only the
 * inner reservation is carried (pool fields left undefined) and the composite
 * is effectively a thin wrapper over the inner reservation.
 */
export function compositeFromInner(
  inner: BudgetReservation,
  attemptId: string
): CompositeBudgetReservation {
  return {
    ...inner,
    reservationKey: inner.id,
    attemptId,
    status: "pending"
  };
}

/**
 * Attach Token Pool metadata to an existing composite (or inner-only)
 * reservation after the pool reserve succeeds.
 */
export function withPoolReservation(
  base: CompositeBudgetReservation,
  pool: {
    poolReservationId: string;
    poolId: string;
    logicalModelId: string;
    reservationKey: string;
  }
): CompositeBudgetReservation {
  return {
    ...base,
    poolReservationId: pool.poolReservationId,
    poolId: pool.poolId,
    logicalModelId: pool.logicalModelId,
    reservationKey: pool.reservationKey,
    id: pool.reservationKey
  };
}

/** Type guard: does this reservation carry Token Pool metadata? */
export function hasPoolReservation(reservation: CompositeBudgetReservation): boolean {
  return reservation.poolReservationId !== undefined && reservation.poolId !== undefined;
}
