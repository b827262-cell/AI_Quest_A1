import type { TaskCategory } from "../classification/classification-types";
import type {
  DomainVerificationStrategy,
  KnowledgeClaim,
  KnowledgeClaimAssessment,
  VerificationEvidence,
  VerificationStrategyContext
} from "./verification-evidence";
import { clampEvidenceConfidence, safeEvidenceIssue } from "./verification-evidence";

function normalizeClaim(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s，。！？、,.!?：:；;]/g, "");
}

/** Extracts at most eight stable, sentence-based claims without model calls. */
export function extractKnowledgeClaims(answer: string): KnowledgeClaim[] {
  const sentences = answer
    .split(/[。！？!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 8);
  return sentences.map((text, index) => ({
    id: `claim-${index + 1}`,
    text,
    importance: index === 0 || /因此|結論|總之|主要|核心|therefore|in conclusion/i.test(text) ? "core" : "supporting"
  }));
}

function contradictionKey(text: string): { key: string; negative: boolean } | undefined {
  const normalized = normalizeClaim(text);
  const negative = /不是|並非|不能|不會|不|not|never|cannot|false/.test(normalized);
  const key = normalized
    .replace(/不是|並非|不能|不會|不|not|never|cannot|false|是|is/g, "")
    .replace(/^(答案|結論|theanswer)/, "");
  return key.length >= 3 ? { key, negative } : undefined;
}

export function assessKnowledgeClaims(claims: KnowledgeClaim[]): KnowledgeClaimAssessment[] {
  const assessed = claims.map<KnowledgeClaimAssessment>((claim) => ({
    claimId: claim.id,
    result: "supported",
    severity: "low",
    safeReason: "internally_consistent"
  }));
  const seen = new Map<string, { negative: boolean; index: number }>();
  for (let index = 0; index < claims.length; index += 1) {
    const key = contradictionKey(claims[index].text);
    if (!key) continue;
    const previous = seen.get(key.key);
    if (previous && previous.negative !== key.negative) {
      assessed[index] = { claimId: claims[index].id, result: "contradicted", severity: "high", safeReason: "contradicts_another_core_claim" };
      assessed[previous.index] = { claimId: claims[previous.index].id, result: "contradicted", severity: "high", safeReason: "contradicts_another_core_claim" };
    } else {
      seen.set(key.key, { negative: key.negative, index });
    }
  }
  return assessed;
}

export function buildKnowledgeClaimAssessmentPrompt(claims: KnowledgeClaim[]): string {
  const safeClaims = claims.slice(0, 8).map((claim) => ({ id: claim.id, importance: claim.importance, text: claim.text.slice(0, 240) }));
  return [
    "請只輸出 JSON 陣列，逐一評估 claim id，不要輸出 Chain of Thought。",
    'schema: [{"claimId":"claim-1","result":"supported|contradicted|uncertain|not_checked","severity":"low|medium|high","safeReason":"簡短安全理由"}]',
    JSON.stringify(safeClaims)
  ].join("\n");
}

export class KnowledgeConsistencyVerifier implements DomainVerificationStrategy {
  supports(category: TaskCategory): boolean {
    return category === "knowledge";
  }

  async verify(context: VerificationStrategyContext): Promise<VerificationEvidence> {
    const claims = extractKnowledgeClaims(context.primaryAnswer);
    if (claims.length === 0) {
      return { strategy: "knowledge_consistency", status: "unavailable", confidence: 0, issues: [], safeSummary: "no_claims_extracted" };
    }
    const assessments = assessKnowledgeClaims(claims);
    const contradictions = assessments.filter((assessment) => assessment.result === "contradicted");
    const coreContradiction = contradictions.some((assessment) =>
      claims.find((claim) => claim.id === assessment.claimId)?.importance === "core"
    );
    const issues = coreContradiction
      ? [safeEvidenceIssue("core_claim", "high", "core_claims_are_internally_contradictory")]
      : contradictions.length > 0
        ? [safeEvidenceIssue("supporting_claim", "medium", "supporting_claims_need_review")]
        : [];
    const status = coreContradiction ? "failed" : contradictions.length > 0 ? "partial" : "passed";
    return {
      strategy: "knowledge_consistency",
      status,
      confidence: clampEvidenceConfidence(status === "passed" ? 0.72 : 0.92),
      issues,
      safeSummary: status === "passed" ? "claims_internally_consistent" : "claim_consistency_failed"
    };
  }
}
