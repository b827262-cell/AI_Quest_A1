import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_CATALOG,
  publicActorV1Schema,
  publicApiErrorV1Schema,
  studentRagAskErrorV1Schema,
  studentRagAskRequestV1Schema,
  studentRagAskResponseV1Schema
} from "../src/browser";
import { auditEventV1Schema } from "../src/server";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/v1/${name}.json`, import.meta.url), "utf8"));
}

describe("version 1 compatibility fixtures", () => {
  it("keeps the public API error fixture schema-compatible", () => {
    expect(publicApiErrorV1Schema.parse(fixture("public-api-error"))).toEqual(fixture("public-api-error"));
  });

  it("keeps the public actor fixture schema-compatible", () => {
    expect(publicActorV1Schema.parse(fixture("public-actor"))).toEqual(fixture("public-actor"));
  });

  it("keeps the student RAG ask fixtures schema-compatible", () => {
    expect(studentRagAskRequestV1Schema.parse(fixture("student-rag-ask-request"))).toEqual(fixture("student-rag-ask-request"));
    expect(studentRagAskResponseV1Schema.parse(fixture("student-rag-ask-response"))).toEqual(fixture("student-rag-ask-response"));
    expect(studentRagAskErrorV1Schema.parse(fixture("student-rag-ask-error"))).toEqual(fixture("student-rag-ask-error"));
  });

  it("rejects browser-supplied scope or identity in the RAG ask request", () => {
    const request = fixture("student-rag-ask-request") as Record<string, unknown>;
    expect(() => studentRagAskRequestV1Schema.parse({ ...request, studentId: "attacker" })).toThrow();
    expect(() => studentRagAskRequestV1Schema.parse({ ...request, scope: { studentId: "attacker", bookId: "book" } })).toThrow();
  });

  it("rejects a breaking removal or incompatible version", () => {
    const current = fixture("public-api-error") as Record<string, unknown>;
    expect(() => publicApiErrorV1Schema.parse({ ...current, contractVersion: 2 })).toThrow();
    expect(() => publicApiErrorV1Schema.parse({ contractVersion: 1 })).toThrow();
  });
});

describe("boundary catalog", () => {
  it("assigns an owner, consumer and schema to each public contract", () => {
    expect(CONTRACT_CATALOG.length).toBeGreaterThan(0);
    for (const entry of CONTRACT_CATALOG) {
      expect(entry.owner).not.toBe("");
      expect(entry.consumers.length).toBeGreaterThan(0);
      expect(entry.schema).toMatch(/Schema$/);
    }
  });

  it("validates server-only audit events independently", () => {
    expect(auditEventV1Schema.parse({
      contractVersion: 1,
      eventId: "event_synthetic_001",
      occurredAt: "2026-08-05T00:00:00Z",
      actorId: null,
      action: "contract.test",
      resourceType: "fixture",
      resourceId: null,
      outcome: "success"
    }).outcome).toBe("success");
  });
});
