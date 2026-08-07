import { createHash } from "node:crypto";

/**
 * Server-only evidence span hashing.
 *
 * The hash is re-derived by the server over a canonicalized evidence span
 * extracted from the actual retrieved chunk. It is never trusted from model
 * output: the validator recomputes it and rejects any mismatch as a
 * tampering/integrity failure (fail-closed), not as a soft grounding gap.
 *
 * Domain separation keeps evidence digests distinct from IP/recovery digests
 * produced elsewhere in the package.
 */

/** Domain prefix so evidence hashes cannot collide with other SHA-256 uses. */
export const EVIDENCE_HASH_DOMAIN = "rag-evidence:";

export const EVIDENCE_HASH_ALGORITHM = "sha256" as const;

/**
 * Canonicalize a span before hashing. Normalization is deliberately minimal
 * and deterministic so the same logical text produces the same hash:
 *   - NFC unicode normalization (folds equivalent compositions)
 *   - trailing whitespace trim
 *   - collapse internal whitespace runs to a single space
 *
 * This defeats trivial tampering (whitespace/zero-width/composition tricks)
 * while keeping the canonical form meaningful for offset re-derivation.
 */
export function canonicalizeEvidenceSpan(span: string): string {
  return span.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Compute the SHA-256 content hash over the canonicalized evidence span.
 * The hex digest (64 lowercase chars) is what travels in the citation /
 * claim evidence for audit; the input span never needs to be re-transmitted.
 */
export function hashEvidenceSpan(span: string): string {
  const canonical = canonicalizeEvidenceSpan(span);
  return createHash("sha256").update(EVIDENCE_HASH_DOMAIN + canonical).digest("hex");
}

/**
 * Verify that a claimed hash matches the server-recomputed hash of the given
 * span. A mismatch means the quote/span was tampered with or does not come
 * from the cited chunk; the caller must fail closed.
 */
export function verifyEvidenceHash(span: string, claimedHash: string): boolean {
  if (typeof claimedHash !== "string" || !/^[a-f0-9]{64}$/.test(claimedHash)) return false;
  return hashEvidenceSpan(span) === claimedHash.toLowerCase();
}
