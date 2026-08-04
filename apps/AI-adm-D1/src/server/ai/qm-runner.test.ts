import { describe, it, expect } from "vitest";
import {
  MAX_OUTPUT_BYTES,
  QmOperationBusyError,
  buildQmChildEnv,
  buildQmRunEnv,
  createQmRunner,
  parseContractResult,
  parseDoctorResult,
  redactSecrets,
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

  it("classifies provider credentials, local secrets, and runtime URL separately", () => {
    const stdout = "error: required secrets are missing or placeholders: ANTHROPIC_API_KEY, CAPABILITY_SECRET, CORE_SIGNING_SECRET, PUBLIC_API_URL";
    const result = parseDoctorResult(stdout, "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(3);
    expect(result.blockers.find((blocker) => blocker.category === "credential")).toMatchObject({ names: ["ANTHROPIC_API_KEY"] });
    expect(result.blockers.find((blocker) => blocker.category === "local_secret")).toMatchObject({ names: ["CAPABILITY_SECRET", "CORE_SIGNING_SECRET"] });
    expect(result.blockers.find((blocker) => blocker.category === "configuration")).toMatchObject({ names: ["PUBLIC_API_URL"] });
  });

  it("detects credential blocker from individual missing secret lines", () => {
    const stdout = "OPENAI_API_KEY is missing\nCORE_SIGNING_SECRET is still a placeholder";
    const result = parseDoctorResult(stdout, "", 1);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers.find((blocker) => blocker.category === "credential")).toMatchObject({ names: ["OPENAI_API_KEY"] });
    expect(result.blockers.find((blocker) => blocker.category === "local_secret")).toMatchObject({ names: ["CORE_SIGNING_SECRET"] });
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

describe("QM child environment boundary", () => {
  it("keeps only runtime variables and excludes Admin or credential values", () => {
    const env = buildQmChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      LANG: "zh_TW.UTF-8",
      ADMIN_API_TOKEN: "must-not-cross",
      ANTHROPIC_API_KEY: "must-not-cross",
      CUSTOM_ENV: "must-not-cross"
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/operator", LANG: "zh_TW.UTF-8" });
    expect(JSON.stringify(env)).not.toContain("must-not-cross");
  });
});

describe("buildQmRunEnv per-run secret isolation", () => {
  it("merges run secrets onto the minimal child env without touching process.env", () => {
    const sentinel = "RUN_SECRET_SENTINEL_VALUE";
    delete process.env.RUN_SECRET;
    try {
      const env = buildQmRunEnv({ RUN_SECRET: sentinel }, { PATH: "/usr/bin", HOME: "/h" });
      expect(env.RUN_SECRET).toBe(sentinel);
      expect(env.PATH).toBe("/usr/bin");
      // The shared process.env is never mutated.
      expect(process.env.RUN_SECRET).toBeUndefined();
    } finally {
      delete process.env.RUN_SECRET;
    }
  });

  it("produces independent env objects for concurrent runs (no cross-contamination)", () => {
    const envA = buildQmRunEnv({ RUN_SECRET: "A" });
    const envB = buildQmRunEnv({ RUN_SECRET: "B" });
    expect(envA.RUN_SECRET).toBe("A");
    expect(envB.RUN_SECRET).toBe("B");
    expect(envA).not.toBe(envB);
    expect("A" in envB).toBe(false);
    expect("B" in envA).toBe(false);
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

/* ── Deterministic lock tests via injected dependencies ───────
 * These tests never touch a real QM binary, npx/Node-24 download, local
 * credentials, or subprocess timing: `spawnCapture` is replaced with a
 * stub returning deferred promises the test resolves/rejects explicitly. */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okSpawnResult(stdout = ""): SpawnCaptureResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, spawnError: false };
}

function timedOutSpawnResult(): SpawnCaptureResult {
  return { stdout: "", stderr: "", exitCode: -1, timedOut: true, spawnError: false };
}

/** Fake `spawnCapture` that hands the test a deferred promise per call. */
function createControlledSpawnCapture(): {
  spawnCapture: QmRunnerDependencies["spawnCapture"];
  calls: Array<Deferred<SpawnCaptureResult>>;
} {
  const calls: Array<Deferred<SpawnCaptureResult>> = [];
  const spawnCapture: QmRunnerDependencies["spawnCapture"] = () => {
    const deferred = createDeferred<SpawnCaptureResult>();
    calls.push(deferred);
    return deferred.promise;
  };
  return { spawnCapture, calls };
}

function createTestRunner(overrides: Partial<QmRunnerDependencies> = {}) {
  return createQmRunner({
    existsQmBin: () => true,
    readQmCliVersion: () => "0.1.4",
    now: () => "2024-01-01T00:00:00.000Z",
    ...overrides
  });
}

const VALID_CONTRACT_JSON = JSON.stringify({ contract: 1, valid: true, clauses: {} });

/**
 * `runValidate` issues its second `spawnCapture` call (doctor) only after
 * the first call's deferred promise resolves and the async function
 * resumes. Resolving `calls[index]` requires first waiting for that call to
 * exist; flushing microtasks (no real timers, no polling delay) makes that
 * deterministic instead of racing vitest's own timeout.
 */
async function resolveCall(
  calls: Array<Deferred<SpawnCaptureResult>>,
  index: number,
  result: SpawnCaptureResult
): Promise<void> {
  while (calls.length <= index) {
    await Promise.resolve();
  }
  calls[index].resolve(result);
}

describe("qm-runner concurrent lock", () => {
  it("rejects a duplicate validate call before any async work resolves", async () => {
    const { spawnCapture, calls } = createControlledSpawnCapture();
    const runner = createTestRunner({ spawnCapture });

    const first = runner.runValidate();
    const second = runner.runValidate().catch((error: unknown) => error);

    const secondResult = await second;
    expect(secondResult).toBeInstanceOf(QmOperationBusyError);
    expect((secondResult as Error).message).toContain("operation_already_running");

    // Unblock the first call's two spawnCapture invocations (check, doctor)
    // so the deferred promises this test created don't leak into others.
    await resolveCall(calls, 0, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 1, okSpawnResult());
    await first;
  });

  it("uses the same lock for validate and smoke", async () => {
    const { spawnCapture, calls } = createControlledSpawnCapture();
    const runner = createTestRunner({ spawnCapture });

    const first = runner.runValidate();
    const second = runner.runSmoke().catch((error: unknown) => error);

    const secondResult = await second;
    expect(secondResult).toBeInstanceOf(QmOperationBusyError);

    await resolveCall(calls, 0, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 1, okSpawnResult());
    await first;
  });

  it("releases the lock once the operation resolves", async () => {
    const { spawnCapture, calls } = createControlledSpawnCapture();
    const runner = createTestRunner({ spawnCapture });

    const first = runner.runValidate();
    await resolveCall(calls, 0, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 1, okSpawnResult());
    await first;

    // The lock must be free now; a second call should proceed to spawn again
    // instead of rejecting with QmOperationBusyError.
    const second = runner.runValidate();
    await resolveCall(calls, 2, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 3, okSpawnResult());
    await expect(second).resolves.toBeDefined();
  });

  it("releases the lock after the operation rejects", async () => {
    const { spawnCapture, calls } = createControlledSpawnCapture();
    const runner = createTestRunner({ spawnCapture });

    const first = runner.runValidate().catch((error: unknown) => error);
    calls[0]?.reject(new Error("boom"));
    const firstResult = await first;
    expect(firstResult).toBeInstanceOf(Error);
    expect((firstResult as Error).message).toBe("boom");

    // The lock must be released even though the operation threw.
    const second = runner.runValidate();
    await resolveCall(calls, 1, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 2, okSpawnResult());
    await expect(second).resolves.toBeDefined();
  });

  it("releases the lock after a simulated timeout/process failure", async () => {
    const { spawnCapture, calls } = createControlledSpawnCapture();
    const runner = createTestRunner({ spawnCapture });

    const first = runner.runValidate();
    await resolveCall(calls, 0, timedOutSpawnResult());
    const firstStatus = await first;
    expect(firstStatus.contract.valid).toBe(false);
    expect(firstStatus.doctor.status).toBe("fail");

    const second = runner.runValidate();
    await resolveCall(calls, 1, okSpawnResult(VALID_CONTRACT_JSON));
    await resolveCall(calls, 2, okSpawnResult());
    await expect(second).resolves.toBeDefined();
  });

  it("does not touch a real QM binary when existsQmBin reports it missing", async () => {
    const runner = createTestRunner({
      existsQmBin: () => false,
      spawnCapture: () => {
        throw new Error("spawnCapture must not be called when the QM binary is absent");
      }
    });

    const status = await runner.runValidate();
    expect(status.contract.valid).toBe(false);
    expect(status.doctor.status).toBe("fail");
  });
});
