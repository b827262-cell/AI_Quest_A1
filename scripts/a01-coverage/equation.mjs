/**
 * Coverage equation (PROPOSAL ONLY) for the A-01 72h window.
 *
 *   ingress_total = verify + probe_stripped + health + books + sync + cors + static
 *   difference must be 0
 *
 * This identity is a proposal. It is NOT confirmed by the Owner, and the label
 * is attached to every output so a reader cannot mistake it for an agreed rule.
 * Bucket names and the ingress total are configurable inputs.
 */

export const EQUATION_LABEL = "proposal, unconfirmed (not confirmed by Owner)";

export const DEFAULT_BUCKETS = Object.freeze([
  "verify",
  "probeStripped",
  "health",
  "books",
  "sync",
  "cors",
  "static",
]);

/**
 * @param {object} input
 * @param {number} input.ingressTotal total ingress invocations in the window
 * @param {Record<string, number>} input.buckets per-bucket counts
 * @returns {object} equation result with an explicit proposal label
 */
export function computeEquation(input = {}) {
  const ingressTotal = Number(input.ingressTotal ?? 0);
  const provided = input.buckets ?? {};
  const names = input.bucketNames
    ?? (Object.keys(provided).length > 0 ? Object.keys(provided) : DEFAULT_BUCKETS);

  const buckets = {};
  let sum = 0;
  for (const name of names) {
    const value = Number(provided[name] ?? 0);
    buckets[name] = value;
    sum += value;
  }
  const diff = ingressTotal - sum;
  return {
    label: EQUATION_LABEL,
    ingress_total: ingressTotal,
    buckets,
    bucket_names: names,
    sum,
    difference: diff,
    ok: diff === 0,
  };
}
