import { describe, expect, it } from "vitest";
import { EvaluationDatasetError, parseEvaluationDataset } from "../../src";

const validCase = { id: "math-basic-001", version: 1, category: "mathematics", difficulty: "easy", question: "2 + 3", expected: { kind: "numeric", expectedValue: 5, tolerance: 0 }, source: "synthetic", enabled: true };
const validDataset = () => ({ id: "phase-4a-test", version: 1, cases: [validCase] });

describe("evaluation dataset parser", () => {
  it("parses a valid dataset", () => expect(parseEvaluationDataset(validDataset()).cases).toHaveLength(1));
  it("rejects duplicate ids", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [validCase, validCase] })).toThrow(EvaluationDatasetError));
  it("rejects empty question", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, question: " " }] })).toThrow());
  it("rejects invalid category", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, category: "other" }] })).toThrow());
  it("rejects invalid difficulty", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, difficulty: "urgent" }] })).toThrow());
  it("rejects invalid expectation kind", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, expected: { kind: "model_self_score" } }] })).toThrow());
  it("rejects negative tolerance", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, expected: { kind: "numeric", expectedValue: 1, tolerance: -1 } }] })).toThrow());
  it("rejects empty accepted answers", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, expected: { kind: "exact", acceptedAnswers: [] } }] })).toThrow());
  it("rejects empty required concepts", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, expected: { kind: "required_concepts", required: [] } }] })).toThrow());
  it("skips disabled cases at execution time while retaining them in dataset", () => expect(parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, enabled: false }] }).cases[0]?.enabled).toBe(false));
  it("rejects an API key shaped dataset value", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, question: "api_key: sk-abcdefghijklmnop" }] })).toThrow());
  it("rejects an authorization header", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, question: "Authorization: Bearer abcdefghijklmnop" }] })).toThrow());
  it("rejects an AQ. key shaped dataset value", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, question: "AQ.abcdefghijklmnopqrstuvwxyz123456" }] })).toThrow());
  it("rejects unsafe case ids", () => expect(() => parseEvaluationDataset({ ...validDataset(), cases: [{ ...validCase, id: "../secret" }] })).toThrow());
  it("rejects non-positive dataset version", () => expect(() => parseEvaluationDataset({ ...validDataset(), version: 0 })).toThrow());
});
