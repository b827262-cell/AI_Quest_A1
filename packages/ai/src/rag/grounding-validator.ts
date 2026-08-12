import type {
  GroundingValidationInput,
  GroundingValidationResult,
  GroundingValidator,
  ValidatedClaimSupport
} from "./ports";
import type { RagClaimGrounding, RagClaimRiskCategory } from "./contracts";

/**
 * Deterministic rule-based grounding validator.
 *
 * Production wiring may substitute an independent LLM-backed validator with
 * its own prompt/model/config, but the verdict must still respect the
 * GroundingValidator contract: generator confidence is never an input, and
 * any internal failure resolves to "abstained" (never "verified").
 *
 * Rule design (per claim, never aggregated so a strong source cannot mask
 * an unsupported claim):
 *   - general claim: LOCALIZED WINDOW matching. The claim is scored against
 *     the best token window of each cited chunk, where every candidate
 *     window size is derived from the claim's own token count. Similarity is
 *     a Jaccard between the claim tokens and the best window, so chunk
 *     length can no longer inflate the denominator and starve faithful
 *     claims of a "verified" verdict. In addition, the fraction of claim
 *     tokens present anywhere in the cited chunk must reach the coverage
 *     threshold. Windows whose negation polarity contradicts the claim are
 *     never eligible support (contradiction fails closed to unsupported).
 *   - high-risk claim (number/date/formula/proper_noun): every material
 *     literal extracted from the claim must occur verbatim in at least one
 *     cited chunk's content. Approximate/paraphrase support is insufficient.
 */

export type RuleBasedValidatorOptions = {
  /** Minimum localized-window Jaccard similarity for a general claim (0..1). */
  generalWindowSimilarityThreshold?: number;
  /** Minimum fraction of claim content tokens covered by a cited chunk (0..1). */
  generalCoverageThreshold?: number;
  /** Identity string recorded for audit (default identifies this rule version). */
  identity?: string;
};

const DEFAULTS = {
  generalWindowSimilarityThreshold: 0.5,
  generalCoverageThreshold: 0.6,
  identity: "rule-based-v2"
} as const;

export class RuleBasedGroundingValidator implements GroundingValidator {
  private readonly generalWindowSimilarityThreshold: number;
  private readonly generalCoverageThreshold: number;
  private readonly identity: string;

  constructor(options: RuleBasedValidatorOptions = {}) {
    this.generalWindowSimilarityThreshold = options.generalWindowSimilarityThreshold ?? DEFAULTS.generalWindowSimilarityThreshold;
    this.generalCoverageThreshold = options.generalCoverageThreshold ?? DEFAULTS.generalCoverageThreshold;
    this.identity = options.identity ?? DEFAULTS.identity;
  }

  async validate(input: GroundingValidationInput): Promise<GroundingValidationResult> {
    // Fail-closed: a structural problem means we cannot make a verified claim.
    if (input.signal?.aborted) return abstainedResult(this.identity, input.claims);
    if (!Array.isArray(input.claims)) return abstainedResult(this.identity, []);

    const chunkById = new Map(input.retrievedChunks.map((c) => [c.id, c]));
    const claimSupport: ValidatedClaimSupport[] = [];

    for (const claim of input.claims) {
      claimSupport.push(this.assessClaim(claim, input.citations, chunkById));
    }

    const unsupportedClaimCount = claimSupport.filter((c) => c.status === "unsupported").length;
    const verdict = unsupportedClaimCount === 0
      ? (claimSupport.length > 0 ? "verified" : "abstained")
      : "partial";

    return {
      verdict,
      claimSupport,
      unsupportedClaimCount,
      validatorIdentity: this.identity
    };
  }

  private assessClaim(
    claim: RagClaimGrounding,
    citations: GroundingValidationInput["citations"],
    chunkById: Map<string, { content: string }>
  ): ValidatedClaimSupport {
    // Resolve the cited chunks for this claim (intersection of claim citations
    // and structurally-validated citations, restricted to in-scope retrieved set).
    const citedChunkIds = new Set<string>();
    for (const cid of claim.citationChunkIds) {
      if (chunkById.has(cid) && citations.some((c) => c.chunkId === cid)) {
        citedChunkIds.add(cid);
      }
    }

    // No in-scope cited chunk → unsupported (weak source / out of scope).
    if (citedChunkIds.size === 0) {
      return {
        claimId: claim.claimId,
        status: "unsupported",
        supportedByChunkIds: [],
        ...(claim.riskCategory ? { riskCategory: claim.riskCategory } : {}),
        reasonCode: "no_cited_in_scope_chunk"
      };
    }

    const citedContents = [...citedChunkIds].map((id) => chunkById.get(id)!.content);
    const riskCategory = claim.riskCategory ?? detectRiskCategory(claim.text);

    if (riskCategory !== "general") {
      // High-risk claim: every material literal must occur verbatim.
      const literals = extractMaterialLiterals(claim.text, riskCategory);
      if (literals.length > 0) {
        const allPresent = literals.every((lit) =>
          citedContents.some((content) => content.includes(lit))
        );
        if (!allPresent) {
          return {
            claimId: claim.claimId,
            status: "unsupported",
            supportedByChunkIds: [...citedChunkIds],
            riskCategory,
            reasonCode: `${riskCategory}_literal_not_in_evidence`
          };
        }
        return {
          claimId: claim.claimId,
          status: "supported",
          supportedByChunkIds: [...citedChunkIds],
          riskCategory
        };
      }
      // Fall through to general assessment if no literal could be extracted.
    }

    // General claim: localized-window similarity + whole-chunk coverage.
    const claimTokens = tokenize(claim.text);
    if (claimTokens.length === 0) {
      return {
        claimId: claim.claimId,
        status: "unsupported",
        supportedByChunkIds: [...citedChunkIds],
        riskCategory,
        reasonCode: "empty_claim_tokens"
      };
    }

    let bestSimilarity = 0;
    let bestCoverage = 0;
    let bestChunkId = "";
    for (const chunkId of citedChunkIds) {
      const chunkTokens = tokenize(chunkById.get(chunkId)!.content);
      const { similarity } = localizedWindowSimilarity(claimTokens, chunkTokens);
      const coverage = coverageFraction(claimTokens, new Set(chunkTokens));
      if (similarity > bestSimilarity || (similarity === bestSimilarity && coverage > bestCoverage)) {
        bestSimilarity = similarity;
        bestCoverage = coverage;
        bestChunkId = chunkId;
      }
    }

    const supported = bestSimilarity >= this.generalWindowSimilarityThreshold
      && bestCoverage >= this.generalCoverageThreshold
      && bestChunkId !== "";

    return {
      claimId: claim.claimId,
      status: supported ? "supported" : "unsupported",
      supportedByChunkIds: supported ? [bestChunkId] : [...citedChunkIds],
      riskCategory,
      reasonCode: supported ? undefined : "low_window_similarity_or_coverage"
    };
  }
}

function abstainedResult(identity: string, claims: RagClaimGrounding[]): GroundingValidationResult {
  return {
    verdict: "abstained",
    claimSupport: claims.map((c) => ({
      claimId: c.claimId,
      status: "unsupported" as const,
      supportedByChunkIds: [],
      reasonCode: "validator_abstained"
    })),
    unsupportedClaimCount: claims.length,
    validatorIdentity: identity
  };
}

// --- tokenization & similarity --------------------------------------------

const STOP_WORDS = new Set([
  // English ("not"/"no" etc. are deliberately NOT stop words: negation must
  // survive tokenization so contradiction polarity can be detected).
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "as", "and",
  "or", "but", "if", "then", "this", "that", "these", "those",
  "it", "its", "has", "have", "had", "do", "does", "did", "will", "would",
  // CJK particles/common (bigrams handle most CJK; these filter single noise)
  "的", "是", "在", "了", "和", "與", "或", "不", "為", "以", "及"
]);

const NEGATION_TOKENS = new Set([
  "not", "no", "never", "cannot", "without", "none", "neither", "nor"
]);

function negationParity(tokens: readonly string[]): number {
  let count = 0;
  for (const token of tokens) {
    if (NEGATION_TOKENS.has(token)) count += 1;
  }
  return count % 2;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // ASCII word tokens (length >= 2), lowercased, stop-word filtered. Boundary
  // punctuation is stripped so "planet." and "planet" compare equal, while
  // internal separators survive ("forty-two", "3.14", "m/s").
  const ascii = text.toLowerCase().match(/[a-z0-9][a-z0-9._'-]{1,}/g) ?? [];
  for (const raw of ascii) {
    const t = raw.replace(/^[.,;:!?]+|[.,;:!?]+$/g, "");
    if (t.length >= 2 && !STOP_WORDS.has(t)) tokens.push(t);
  }
  // CJK bigrams — captures most Chinese semantic units.
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

/**
 * Localized window similarity (R-1).
 *
 * Slides claim-length-derived windows over the chunk token stream and returns
 * the best Jaccard similarity between the claim token set and any window.
 * Candidate window sizes are { n, ceil(1.25n), ceil(1.5n) } where n is the
 * claim token count (clamped to the chunk length), so:
 *   - a verbatim claim inside an arbitrarily long chunk reaches similarity 1.0
 *     (a window of exactly n aligned tokens has union == intersection);
 *   - close paraphrases still find a near-claim-sized neighbourhood;
 *   - chunk length never inflates the union term, so long chunks cannot
 *     starve a faithful claim of support.
 * Windows whose negation parity contradicts the claim are skipped, so a
 * chunk that only states the negation of the claim can never support it.
 */
export function localizedWindowSimilarity(
  claimTokens: readonly string[],
  chunkTokens: readonly string[]
): { similarity: number; windowStart: number; windowEnd: number } {
  if (claimTokens.length === 0 || chunkTokens.length === 0) {
    return { similarity: 0, windowStart: 0, windowEnd: 0 };
  }
  const claimSet = new Set(claimTokens);
  const claimParity = negationParity(claimTokens);
  const base = claimTokens.length;
  const sizes = new Set(
    [base, Math.ceil(base * 1.25), Math.ceil(base * 1.5)]
      .map((size) => Math.min(size, chunkTokens.length))
      .filter((size) => size > 0)
  );

  let best = { similarity: 0, windowStart: 0, windowEnd: 0 };
  for (const size of sizes) {
    const freq = new Map<string, number>();
    let distinct = 0;
    let intersection = 0;
    let negations = 0;
    for (let i = 0; i < chunkTokens.length; i++) {
      const added = chunkTokens[i];
      const addedFreq = (freq.get(added) ?? 0) + 1;
      freq.set(added, addedFreq);
      if (addedFreq === 1) {
        distinct += 1;
        if (claimSet.has(added)) intersection += 1;
        if (NEGATION_TOKENS.has(added)) negations += 1;
      }
      const removedIndex = i - size;
      if (removedIndex >= 0) {
        const removed = chunkTokens[removedIndex];
        const removedFreq = freq.get(removed)! - 1;
        if (removedFreq === 0) {
          freq.delete(removed);
          distinct -= 1;
          if (claimSet.has(removed)) intersection -= 1;
          if (NEGATION_TOKENS.has(removed)) negations -= 1;
        } else {
          freq.set(removed, removedFreq);
        }
      }
      if (i < size - 1) continue;
      // Contradiction guard: a window whose negation polarity disagrees with
      // the claim states the opposite and can never be supporting evidence.
      if (negations % 2 !== claimParity) continue;
      const union = claimSet.size + distinct - intersection;
      const similarity = union === 0 ? 0 : intersection / union;
      if (similarity > best.similarity) {
        best = { similarity, windowStart: removedIndex + 1, windowEnd: i + 1 };
      }
    }
  }
  return best;
}

export function coverageFraction(claimTokens: string[], chunkSet: Set<string>): number {
  if (claimTokens.length === 0) return 0;
  const claimSet = new Set(claimTokens);
  let covered = 0;
  for (const t of claimSet) {
    if (chunkSet.has(t)) covered += 1;
  }
  return covered / claimSet.size;
}

// --- risk category & material literal extraction ---------------------------

export function detectRiskCategory(text: string): RagClaimRiskCategory {
  if (/\d/.test(text)) {
    // Date takes priority: a 4-digit year with date context is a date, not a number.
    if (/\d{4}/.test(text) && /(年|月|日|year|month|day|sailed|century|ad|bc|bce|ce)/i.test(text)) return "date";
    if (/\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)/.test(text)) return "date";
    if (/\d+(\.\d+)?%/.test(text)) return "number";
    if (/\d{2,}/.test(text)) return "number";
    if (/\d+\.\d+/.test(text)) return "number";
  }
  // Formulas: presence of operators between alphanumerics (e.g. a^2+b^2, E=mc^2).
  if (/[a-z0-9]\s*[\^*/=+\-]\s*[a-z0-9]/i.test(text) && /\d|[a-z]{2,}/i.test(text)) {
    return "formula";
  }
  return "general";
}

/**
 * Extract material literals that must appear verbatim in evidence for a
 * high-risk claim to be considered supported.
 *   - number: standalone numeric values (42, 3.14, 95%, 1.5e3)
 *   - date: 4-digit year runs, and yyyy/mm/dd or yyyy-mm-dd sequences
 *   - formula: the full formula expression containing an operator
 */
export function extractMaterialLiterals(text: string, category: RagClaimRiskCategory): string[] {
  const literals = new Set<string>();
  if (category === "number") {
    for (const m of text.matchAll(/(?:\d+(?:\.\d+)?%?|\d+\.?\d*(?:e[+-]?\d+)?)/gi)) {
      const v = m[0].trim();
      // Only treat as material if it has a digit (filters empty/catch-all).
      if (/\d/.test(v)) literals.add(v);
    }
  } else if (category === "date") {
    for (const m of text.matchAll(/\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?/g)) {
      literals.add(m[0]);
    }
  } else if (category === "formula") {
    for (const m of text.matchAll(/[a-z0-9][a-z0-9()\s.^*/=+\-]*[a-z0-9)]/gi)) {
      const candidate = m[0].trim();
      // Keep only candidates that actually contain an operator and a digit or 2+ letters.
      if (/[\^*/=+\-]/.test(candidate) && (/\d/.test(candidate) || /[a-z]{2,}/i.test(candidate))) {
        literals.add(candidate);
      }
    }
  }
  return [...literals];
}
