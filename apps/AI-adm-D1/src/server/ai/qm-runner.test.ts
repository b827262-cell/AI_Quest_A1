import { describe, it, expect } from "vitest";
import {
  MAX_OUTPUT_BYTES,
  QmOperationBusyError,
  createQmRunner,
  parseContractResult,
  parseDoctorResult,
  redactSecrets,
  runSmoke,
  runValidate,
  spawnCapture,
  type QmRunnerDependencies,
  type SpawnCaptureResult
} from "./qm-runner";

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

  it("redacts unknown token-shaped values and secret-looking output", () => {
    const output = redactSecrets("token=opaque-token-value-1234567890 SECRET_VALUE=plain-secret-value");
    expect(output).not.toContain("opaque-token-value-1234567890");
    expect(output).not.toContain("plain-secret-value");
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
    const clause = result.clauses["secrets.computed-set"] as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(clause, "names")).toBe(false);
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
    expect(result.status).toBe("fail");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].category).toBe("unknown");
    expect(result.blockers[0].code).toBe("doctor_failed");
  });

  it("does not expose raw paths or unknown output in a failure", () => {
    const result = parseDoctorResult("error at /home/user/project/file.ts SECRET_VALUE=never-return-this", "", 1);
    expect(result.blockers[0].message).not.toContain("/home/user");
    expect(result.blockers[0].message).not.toContain("SECRET_VALUE");
    expect(result.message).toBe("QM Doctor failed for an unclassified reason.");
  });

  it("classifies a doctor process failure as fail", () => {
    const result = parseDoctorResult("node crashed with an unexpected error", "", 127);
    expect(result.status).toBe("fail");
    expect(result.blockers[0].category).toBe("unknown");
  });
});

describe("spawnCapture", () => {
  it("caps stdout/stderr by actual UTF-8 bytes", async () => {
    const result = await spawnCapture(
      process.execPath,
      ["-e", "const s = '中文字'.repeat(10000); process.stdout.write(s); process.stderr.write(s)"],
      process.cwd()
    );
    expect(result.spawnError).toBe(false);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it("terminates a timed-out process with SIGTERM then SIGKILL grace", async () => {
    const result = await spawnCapture(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      process.cwd(),
      20,
      20
    );
    expect(result.timedOut).toBe(true);
    expect(result.spawnError).toBe(false);
  });
});

describe("qm-runner concurrent lock", () => {
  it("rejects duplicate validate with operation_already_running", async () => {
    const p1 = runValidate().catch((e) => e);
    const p2 = runValidate().catch((e) => e);

    const r2 = await p2;
    expect(r2).toBeInstanceOf(Error);
    expect(r2.message).toMatch(/operation_already_running/);
    await p1;
  }, 20000);

  it("uses the same lock for validate and smoke", async () => {
    const first = runValidate().catch((error) => error);
    const second = runSmoke().catch((error) => error);

    const secondResult = await second;
    expect(secondResult).toBeInstanceOf(Error);
    expect(secondResult.message).toMatch(/operation_already_running/);
    await first;
  }, 20000);

  it("releases the global lock after an operation completes", async () => {
    await runValidate();
    await runSmoke();
  }, 30000);
});
