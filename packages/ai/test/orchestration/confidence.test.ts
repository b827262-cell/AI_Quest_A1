import { describe, expect, it } from "vitest";
import { deriveAnswerConfidence, type VerificationEvidence } from "../../src";

const passed: VerificationEvidence = {
  strategy: "mathematical_numeric",
  status: "passed",
  confidence: 0.99,
  issues: []
};
const unavailable: VerificationEvidence = {
  strategy: "generic_model",
  status: "unavailable",
  confidence: 0,
  issues: []
};

describe("answer confidence summary", () => {
  it("uses deterministic_verified for deterministic pass plus model agree", () => {
    expect(deriveAnswerConfidence("verified", passed, true, "agree")).toEqual({ level: "high", basis: "deterministic_verified" });
  });

  it("uses model_verified when no deterministic pass exists", () => {
    expect(deriveAnswerConfidence("verified", unavailable, true, "agree")).toEqual({ level: "medium", basis: "model_verified" });
  });

  it("uses medium confidence for supplemented answers", () => {
    expect(deriveAnswerConfidence("supplemented", passed, true, "supplement")).toEqual({ level: "medium", basis: "model_verified" });
  });

  it("uses adjudicated basis without consuming model self-reported probability", () => {
    expect(deriveAnswerConfidence("adjudicated", unavailable, true)).toEqual({ level: "medium", basis: "adjudicated" });
  });

  it("marks Primary Only as unverified", () => {
    expect(deriveAnswerConfidence("primary_only", unavailable, false)).toEqual({ level: "unverified", basis: "primary_only" });
  });

  it("marks unresolved conflicts as low confidence", () => {
    expect(deriveAnswerConfidence("unresolved", passed, true, "conflict")).toEqual({ level: "low", basis: "conflict_unresolved" });
  });
});
