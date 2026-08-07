import { describe, expect, it } from "vitest";
import {
  canonicalizeEvidenceSpan,
  EVIDENCE_HASH_DOMAIN,
  hashEvidenceSpan,
  verifyEvidenceHash
} from "../../src/rag/server";

describe("evidence span hashing", () => {
  it("produces a stable 64-char lowercase hex sha256 with domain separation", () => {
    const hash = hashEvidenceSpan("光合作用 is photosynthesis");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Same input → same hash (deterministic).
    expect(hashEvidenceSpan("光合作用 is photosynthesis")).toBe(hash);
    // Different from a raw sha256 (domain prefix is applied).
    expect(hash).not.toBe(require("node:crypto").createHash("sha256").update("光合作用 is photosynthesis").digest("hex"));
  });

  it("treats tampered evidence as a hash mismatch (fail-closed)", () => {
    const original = "The speed of light is 299792458 m/s.";
    const tampered = "The speed of light is 300000000 m/s.";
    const hash = hashEvidenceSpan(original);
    expect(verifyEvidenceHash(original, hash)).toBe(true);
    expect(verifyEvidenceHash(tampered, hash)).toBe(false);
  });

  it("rejects malformed claimed hashes", () => {
    expect(verifyEvidenceHash("text", "")).toBe(false);
    expect(verifyEvidenceSpan("text", "not-a-hash")).toBe(false);
    expect(verifyEvidenceHash("text", "ABCDEF0123456789".repeat(4))).toBe(false); // uppercase
  });

  it("canonicalizes unicode composition (NFC) so equivalent text hashes equally", () => {
    // é as a single composed codepoint vs decomposed (e + combining accent).
    const composed = "café".normalize("NFC");
    const decomposed = "café".normalize("NFD");
    expect(composed).not.toBe(decomposed); // different code-unit sequences
    expect(hashEvidenceSpan(composed)).toBe(hashEvidenceSpan(decomposed));
  });

  it("canonicalizes whitespace so trivial padding does not change the hash", () => {
    const a = "photosynthesis  converts\tlight";
    const b = "photosynthesis converts light";
    expect(hashEvidenceSpan(a)).toBe(hashEvidenceSpan(b));
  });

  it("keeps evidence digests domain-separated from other sha256 uses", () => {
    const other = require("node:crypto").createHash("sha256")
      .update("guest-ip:same-text").digest("hex");
    const evidence = hashEvidenceSpan("same-text");
    expect(evidence).not.toBe(other);
    expect(EVIDENCE_HASH_DOMAIN).toBe("rag-evidence:");
  });

  it("canonicalizeEvidenceSpan is idempotent", () => {
    const span = "  multiple   spaces  ";
    const once = canonicalizeEvidenceSpan(span);
    const twice = canonicalizeEvidenceSpan(once);
    expect(twice).toBe(once);
    expect(once).toBe("multiple spaces");
  });

  it("detects offset-based tampering: slicing at a wrong boundary yields a different hash", () => {
    const chunk = "The answer is forty-two and the question is unknown.";
    const correctSpan = chunk.slice(0, 25);
    const shiftedSpan = chunk.slice(1, 26);
    expect(hashEvidenceSpan(correctSpan)).not.toBe(hashEvidenceSpan(shiftedSpan));
  });
});

function verifyEvidenceSpan(span: string, claimedHash: string): boolean {
  return verifyEvidenceHash(span, claimedHash);
}
