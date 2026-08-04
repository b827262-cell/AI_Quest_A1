import { describe, it, expect } from "vitest";
import { parseContractResult, parseDoctorResult, redactSecrets } from "./qm-runner";

describe("redactSecrets", () => {
  it("removes sk-ant-* keys", () => {
    expect(redactSecrets("key: sk-ant-api0123456789")).not.toContain("sk-ant-api0123456789");
    expect(redactSecrets("key: sk-ant-api0123456789")).toContain("[REDACTED]");
  });

  it("removes sk-proj-* keys", () => {
    expect(redactSecrets("sk-proj-abcdef")).not.toContain("sk-proj-abcdef");
  });

  it("removes sk-or-* keys", () => {
    expect(redactSecrets("sk-or-xyz123")).not.toContain("sk-or-xyz123");
  });

  it("removes Bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer my-token-123");
    expect(result).not.toContain("my-token-123");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("removes absolute paths", () => {
    expect(redactSecrets("file at /home/user/project/src")).not.toContain("/home/user/project/src");
    expect(redactSecrets("file at /home/user/project/src")).toContain("[PATH]");
  });

  it("preserves non-sensitive text", () => {
    const text = "This is a normal log message";
    expect(redactSecrets(text)).toBe(text);
  });

  it("strips values after = signs to prevent secret leakage", () => {
    const result = redactSecrets("ANTHROPIC_API_KEY=sk-ant-secret123");
    expect(result).not.toContain("sk-ant-secret123");
  });
});

describe("parseContractResult", () => {
  it("parses valid qm check --json output", () => {
    const stdout = JSON.stringify({
      contract: 1,
      valid: true,
      clauses: {
        "config.v1": { status: "pass" },
        "sandbox.descriptors": { status: "pass", warnings: [] },
        "plugins.resolved": { status: "pass", count: 0 },
        "secrets.computed-set": { status: "pass", names: ["ANTHROPIC_API_KEY"] }
      }
    });
    const result = parseContractResult(stdout);
    expect(result.valid).toBe(true);
    expect(result.version).toBe(1);
    expect(result.clauses["config.v1"].status).toBe("pass");
    expect(result.clauses["plugins.resolved"].count).toBe(0);
  });

  it("strips names from secret clause for security", () => {
    const stdout = JSON.stringify({
      contract: 1,
      valid: true,
      clauses: {
        "secrets.computed-set": { status: "pass", names: ["SECRET_KEY"] }
      }
    });
    const result = parseContractResult(stdout);
    expect((result.clauses["secrets.computed-set"] as any).names).toBeUndefined();
  });

  it("handles empty/malformed JSON", () => {
    const result = parseContractResult("not json");
    expect(result.valid).toBe(false);
    expect(result.version).toBe(0);
    expect(result.clauses).toEqual({});
  });
});

describe("parseDoctorResult", () => {
  it("returns pass when exitCode 0", () => {
    const result = parseDoctorResult("all prerequisites met", "", 0);
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.blockers).toEqual([]);
  });

  it("detects credential blocker from bulk missing secrets message", () => {
    const stdout = "error: required secrets are missing or placeholders: ANTHROPIC_API_KEY, CAPABILITY_SECRET, CORE_SIGNING_SECRET";
    const result = parseDoctorResult(stdout, "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].category).toBe("credential");
    if (result.blockers[0].category === "credential") {
      expect(result.blockers[0].code).toBe("missing_or_placeholder");
      expect(result.blockers[0].names).toContain("ANTHROPIC_API_KEY");
      expect(result.blockers[0].names).toContain("CORE_SIGNING_SECRET");
    }
  });

  it("detects credential blocker from individual missing secret lines", () => {
    const stdout = "OPENAI_API_KEY is missing\nCORE_SIGNING_SECRET is still a placeholder";
    const result = parseDoctorResult(stdout, "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].category).toBe("credential");
    if (result.blockers[0].category === "credential") {
      expect(result.blockers[0].names).toContain("OPENAI_API_KEY");
      expect(result.blockers[0].names).toContain("CORE_SIGNING_SECRET");
    }
  });

  it("does not leak credential values — only names", () => {
    const stdout = "error: required secrets are missing or placeholders: API_KEY, SECRET";
    const result = parseDoctorResult(stdout, "", 1);
    const serialized = JSON.stringify(result);
    // Should not contain = followed by a value (env-like patterns)
    expect(serialized).not.toMatch(/=[a-zA-Z0-9]{8,}/);
  });

  it("detects tool blocker only when output mentions tool as missing", () => {
    const result = parseDoctorResult("flyctl: command not found", "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].category).toBe("tool");
    if (result.blockers[0].category === "tool") {
      expect(result.blockers[0].name).toBe("flyctl");
    }
  });

  it("does NOT hardcode flyctl when output doesn't mention it", () => {
    const stdout = "error: required secrets are missing or placeholders: KEY1";
    const result = parseDoctorResult(stdout, "", 1);
    const hasToolBlocker = result.blockers.some(b => b.category === "tool");
    expect(hasToolBlocker).toBe(false);
  });

  it("produces unknown blocker for unrecognised errors", () => {
    const result = parseDoctorResult("some random error output", "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].category).toBe("unknown");
    expect(result.blockers[0].code).toBe("doctor_failed");
  });

  it("redacts absolute paths in unknown blocker message", () => {
    const result = parseDoctorResult("error at /home/user/project/file.ts", "", 1);
    expect(result.blockers[0].message).not.toContain("/home/user");
    expect(result.blockers[0].message).toContain("[PATH]");
  });
});

describe("qm-runner concurrent lock", () => {
  it("rejects duplicate validate with operation_already_running", async () => {
    // Since we can't easily mock spawn in ESM, we test the synchronous lock guard.
    // The Set-based lock is synchronous, so calling runValidate twice immediately
    // should cause the second to fail before any async work begins.
    const { runValidate } = await import("./qm-runner");

    // First call will start and eventually fail (no real QM binary in test),
    // but it takes the lock synchronously.
    const p1 = runValidate().catch(e => e);

    // Second call should fail immediately with lock error.
    const p2 = runValidate().catch(e => e);

    const [r1, r2] = await Promise.all([p1, p2]);
    const errors = [r1, r2].filter(r => r instanceof Error);
    const lockError = errors.find(e => e.message.includes("operation_already_running"));
    expect(lockError).toBeDefined();
  });
});
