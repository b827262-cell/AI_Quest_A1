import { spawn, type ChildProcessByStdio } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type {
  QmSystemStatus,
  QmStatusResponse,
  QmContractResult,
  QmDoctorResult,
  QmSmokeResult,
  QmDoctorBlocker
} from "@ai-smartbook/contracts";
import {
  deriveOverallStatus,
  makeQmNotCheckedStatus,
  qmDoctorResultSchema,
  qmStatusResponseSchema
} from "@ai-smartbook/contracts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "../../../../..");
const DEPLOY_QM_DIR = resolve(PROJECT_ROOT, "deploy/qm");
const QM_BIN = resolve(DEPLOY_QM_DIR, "node_modules/.bin/qm");

export const RUNNER_TIMEOUT_MS = 30_000;
export const TIMEOUT_GRACE_MS = 250;
export const MAX_OUTPUT_BYTES = 8192;

/* ── Secret / path redaction ───────────────────────────────── */

const REDACT_PATTERNS: [RegExp, string][] = [
  [/\bsk-(?:ant|proj|or)-[a-zA-Z0-9_-]+\b/g, "[REDACTED]"],
  [/\b(?:api[-_ ]?key|access[-_ ]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[SECRET_REDACTED]"],
  [/\bBearer\s+[^\s"]+/gi, "Bearer [REDACTED]"],
  [/\b[A-Z][A-Z0-9_]{2,}=[^\s,;]+/g, "[ENV_REDACTED]"],
  [/\/(?:home|Users|root|tmp)\/[^\s"]+/g, "[PATH]"],
  [/[A-Za-z]:\\[^\s"]+/g, "[PATH]"]
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

const SAFE_DOCTOR_UNKNOWN_MESSAGE = "QM Doctor failed for an unclassified reason.";
const SAFE_DOCTOR_PROCESS_MESSAGE = "QM Doctor could not complete because the process failed.";

/* ── Contract parsing ──────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether the CLI emitted the structured check response we expect. */
export function isContractOutputParseable(stdout: string): boolean {
  try {
    const raw: unknown = JSON.parse(stdout.trim());
    return isRecord(raw)
      && typeof raw.valid === "boolean"
      && typeof raw.contract === "number"
      && isRecord(raw.clauses);
  } catch {
    return false;
  }
}

export function parseContractResult(stdout: string): QmContractResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isRecord(parsed)) return { valid: false, version: 0, clauses: {} };

    const result: QmContractResult = {
      valid: parsed.valid === true,
      version: typeof parsed.contract === "number" ? parsed.contract : 0,
      clauses: {}
    };

    if (isRecord(parsed.clauses)) {
      for (const [key, value] of Object.entries(parsed.clauses)) {
        if (!isRecord(value)) {
          result.clauses[key] = { status: "fail" };
          continue;
        }

        // Keep the response useful without forwarding arbitrary CLI text to
        // the browser. The UI only needs status/count; details are fixed safe
        // summaries rather than potentially sensitive stdout fragments.
        const errors = Array.isArray(value.errors) && value.errors.length > 0
          ? ["Contract clause reported an error"]
          : undefined;
        const warnings = Array.isArray(value.warnings) && value.warnings.length > 0
          ? ["Contract clause reported a warning"]
          : undefined;
        result.clauses[key] = {
          status: value.status === "pass" ? "pass" : "fail",
          errors,
          warnings,
          count: typeof value.count === "number" ? value.count : undefined
        };
      }
    }
    return result;
  } catch {
    return { valid: false, version: 0, clauses: {} };
  }
}

/* ── Doctor parsing ────────────────────────────────────────── */

function configurationBlocker(combined: string): QmDoctorBlocker | null {
  if (!/(?:configuration|config|setting)/i.test(combined)) return null;
  if (!/(?:missing|invalid|incomplete|required|not configured|placeholder)/i.test(combined)) return null;
  return {
    category: "configuration",
    code: "configuration_incomplete",
    message: "QM configuration is missing or incomplete"
  };
}

export function parseDoctorResult(stdout: string, stderr: string, exitCode: number): QmDoctorResult {
  if (exitCode === 0) {
    return { status: "pass", exitCode: 0, blockers: [], message: null };
  }

  const combined = `${stdout}\n${stderr}`;
  const blockers: QmDoctorBlocker[] = [];

  // Detect bulk credential issues: "required secrets are missing or placeholders: NAME1, NAME2, ...".
  const credentialBulkMatch = combined.match(
    /required secrets? (?:are|is) missing(?: or placeholders?)?:\s*(.+)/i
  );
  if (credentialBulkMatch) {
    const names = credentialBulkMatch[1]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^[A-Z][A-Z0-9_]+$/.test(value));
    blockers.push({
      category: "credential",
      code: "missing_or_placeholder",
      names,
      message: "Required secrets are missing or placeholders"
    });
  }

  // Detect individual secret issues without ever retaining their values.
  const individualPattern = /([A-Z][A-Z0-9_]+)\s+is\s+(?:missing|still a placeholder)/gi;
  const additionalNames: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = individualPattern.exec(combined)) !== null) {
    additionalNames.push(match[1]);
  }
  if (additionalNames.length > 0 && !credentialBulkMatch) {
    blockers.push({
      category: "credential",
      code: "missing_or_placeholder",
      names: additionalNames,
      message: "Required secrets are missing or placeholders"
    });
  }

  // Detect missing tools only when the output actually mentions a tool as missing.
  const knownTools = ["flyctl", "docker", "terraform", "aws"];
  for (const tool of knownTools) {
    const toolPattern = new RegExp(
      `${tool}[^\\n]*(?:not found|not installed|missing|command not found)`,
      "i"
    );
    if (toolPattern.test(combined)) {
      blockers.push({
        category: "tool",
        code: "missing_tool",
        name: tool,
        message: `${tool} is not installed or not in PATH`
      });
    }
  }

  const config = configurationBlocker(combined);
  if (config) blockers.push(config);

  if (blockers.length === 0) {
    // An unknown non-zero doctor exit is a process/diagnostic failure, not an
    // environment block. The code/message are fixed and contain no CLI text.
    blockers.push({
      category: "unknown",
      code: "doctor_failed",
      message: SAFE_DOCTOR_UNKNOWN_MESSAGE
    });
  }

  const status = blockers.some((blocker) => blocker.category !== "unknown") ? "blocked" : "fail";
  return {
    status,
    exitCode,
    blockers,
    message: status === "blocked"
      ? blockers.map((blocker) => blocker.message).join("; ")
      : SAFE_DOCTOR_UNKNOWN_MESSAGE
  };
}

function processFailureDoctor(exitCode: number): QmDoctorResult {
  return qmDoctorResultSchema.parse({
    status: "fail",
    exitCode,
    blockers: [{
      category: "unknown",
      code: "doctor_failed",
      message: SAFE_DOCTOR_PROCESS_MESSAGE
    }],
    message: SAFE_DOCTOR_PROCESS_MESSAGE
  });
}

/* ── Operation lock error ────────────────────────────────────── */

export class QmOperationBusyError extends Error {
  constructor(operation: "validate" | "smoke") {
    super(`operation_already_running: ${operation}`);
    this.name = "QmOperationBusyError";
  }
}

/* ── Child process helper ──────────────────────────────────── */

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  spawnError: boolean;
};

function appendBytes(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - current.length;
  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

function decodeCapped(buffer: Buffer<ArrayBufferLike>): string {
  let text = buffer.toString("utf8");
  // A byte cap can end in the middle of a UTF-8 sequence. Remove the decoder
  // replacement character in that case so the returned string's encoded byte
  // length never exceeds the cap either.
  while (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    text = text.slice(0, -1);
  }
  return text;
}

/**
 * Capture a fixed child process with a byte-accurate output cap. Timeout first
 * requests graceful termination and only escalates after a short grace period.
 */
export function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number = RUNNER_TIMEOUT_MS,
  graceMs: number = TIMEOUT_GRACE_MS
): Promise<SpawnCaptureResult> {
  return new Promise((resolvePromise) => {
    let stdoutBuffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let stderrBuffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    let child: ChildProcessByStdio<null, Readable, Readable>;

    const finish = (result: SpawnCaptureResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    const result = (exitCode: number, spawnError = false): SpawnCaptureResult => ({
      stdout: decodeCapped(stdoutBuffer),
      stderr: decodeCapped(stderrBuffer),
      exitCode,
      timedOut,
      spawnError
    });

    try {
      child = spawn(cmd, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
      }) as ChildProcessByStdio<null, Readable, Readable>;
    } catch {
      finish(result(-1, true));
      return;
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBuffer = appendBytes(stdoutBuffer, bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBuffer = appendBytes(stderrBuffer, bytes);
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, graceMs);
    }, timeoutMs);

    child.once("error", () => finish(result(-1, true)));
    child.once("close", (code) => finish(result(code ?? 1)));
  });
}

/* ── Node 24 wrapper for QM CLI ────────────────────────────── */

function qmArgs(cliArgs: string[]): { command: string; args: string[] } {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major >= 24) {
    return { command: QM_BIN, args: cliArgs };
  }
  return {
    command: "npx",
    args: ["--yes", "--package=node@24", "--", QM_BIN, ...cliArgs]
  };
}

/* ── Read pinned QM CLI version ────────────────────────────── */

function readQmCliVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(resolve(DEPLOY_QM_DIR, "package.json"), "utf8"));
    const dependencies = isRecord(pkg) && isRecord(pkg.dependencies) ? pkg.dependencies : {};
    const version = dependencies["@yc-software/qm"];
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function notRunSmoke(): QmSmokeResult {
  return { status: "not_run", checkedAt: null, message: null };
}

function smokeFailureMessage(result: SpawnCaptureResult): string {
  if (result.timedOut) return "QM smoke test timed out.";
  if (result.spawnError) return "QM smoke test could not start.";
  return "QM smoke test failed.";
}

/* ── Injectable runner boundary ──────────────────────────────
 * `runValidate`/`runSmoke` depend on subprocess execution, QM binary
 * presence, the pinned CLI version, and wall-clock time. Bundling those as
 * an overridable dependency set lets unit tests drive the operation lock
 * deterministically with stub promises instead of a real `qm` subprocess. */

export type QmRunnerDependencies = {
  spawnCapture: typeof spawnCapture;
  existsQmBin: () => boolean;
  readQmCliVersion: () => string;
  now: () => string;
};

function defaultQmRunnerDependencies(): QmRunnerDependencies {
  return {
    spawnCapture,
    existsQmBin: () => existsSync(QM_BIN),
    readQmCliVersion,
    now: () => new Date().toISOString()
  };
}

export type QmRunner = {
  runValidate(): Promise<QmSystemStatus>;
  runSmoke(): Promise<QmStatusResponse>;
  getCachedQmStatus(): QmStatusResponse | null;
};

/** Build a QM runner. Production code uses the default (real) dependencies. */
export function createQmRunner(overrides: Partial<QmRunnerDependencies> = {}): QmRunner {
  const deps: QmRunnerDependencies = { ...defaultQmRunnerDependencies(), ...overrides };

  let cachedStatus: QmStatusResponse | null = null;
  let runningOperation: "validate" | "smoke" | null = null;

  function acquireOperation(operation: "validate" | "smoke"): void {
    if (runningOperation) throw new QmOperationBusyError(runningOperation);
    runningOperation = operation;
  }

  function releaseOperation(): void {
    runningOperation = null;
  }

  function getCachedQmStatus(): QmStatusResponse | null {
    return cachedStatus ? qmStatusResponseSchema.parse(cachedStatus) : null;
  }

  function updateCachedStatus(next: QmStatusResponse): QmStatusResponse {
    const validated = qmStatusResponseSchema.parse(next);
    cachedStatus = validated;
    return qmStatusResponseSchema.parse(validated);
  }

  function readyStatus(
    contract: QmContractResult,
    doctor: QmDoctorResult,
    smoke: QmSmokeResult,
    qmCliVersion: string
  ): QmSystemStatus {
    return qmStatusResponseSchema.parse({
      state: "ready",
      overallStatus: deriveOverallStatus(contract, doctor, smoke),
      checkedAt: deps.now(),
      qmCliVersion,
      contract,
      doctor,
      smoke
    }) as QmSystemStatus;
  }

  /** Run `qm check --json` and `qm doctor` in the deploy/qm directory. */
  async function runValidate(): Promise<QmSystemStatus> {
    acquireOperation("validate");
    try {
      const qmCliVersion = deps.readQmCliVersion();
      if (!deps.existsQmBin()) {
        const status = readyStatus(
          { valid: false, version: 0, clauses: {} },
          processFailureDoctor(-1),
          cachedStatus?.smoke ?? notRunSmoke(),
          qmCliVersion
        );
        return updateCachedStatus(status) as QmSystemStatus;
      }

      const { command: checkCmd, args: checkArgs } = qmArgs(["check", "--json"]);
      const checkResult = await deps.spawnCapture(checkCmd, checkArgs, DEPLOY_QM_DIR);
      const checkParseable = isContractOutputParseable(checkResult.stdout);
      const parsedContract = parseContractResult(checkResult.stdout);
      const contractResult: QmContractResult = {
        ...parsedContract,
        valid: !checkResult.spawnError && !checkResult.timedOut && checkParseable
          ? parsedContract.valid && checkResult.exitCode === 0
          : false
      };

      let doctor: QmDoctorResult;
      if (checkResult.spawnError || checkResult.timedOut) {
        doctor = processFailureDoctor(checkResult.timedOut ? -1 : checkResult.exitCode);
      } else {
        const { command: doctorCmd, args: doctorArgs } = qmArgs(["doctor"]);
        const doctorProcess = await deps.spawnCapture(doctorCmd, doctorArgs, DEPLOY_QM_DIR);
        doctor = doctorProcess.spawnError || doctorProcess.timedOut
          ? processFailureDoctor(doctorProcess.timedOut ? -1 : doctorProcess.exitCode)
          : parseDoctorResult(doctorProcess.stdout, doctorProcess.stderr, doctorProcess.exitCode);
      }

      const smoke = cachedStatus?.smoke ?? notRunSmoke();
      return updateCachedStatus(readyStatus(contractResult, doctor, smoke, qmCliVersion)) as QmSystemStatus;
    } finally {
      releaseOperation();
    }
  }

  /** Run the feedback workflow smoke test and update only the smoke result. */
  async function runSmoke(): Promise<QmStatusResponse> {
    acquireOperation("smoke");
    try {
      const tsxLoader = resolve(PROJECT_ROOT, "apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs");
      const smokeScript = resolve(PROJECT_ROOT, "scripts/qm-feedback-smoke.ts");
      const result = await deps.spawnCapture(
        process.execPath,
        ["--import", tsxLoader, smokeScript],
        PROJECT_ROOT
      );
      const passed = !result.spawnError && !result.timedOut && result.exitCode === 0 && result.stdout.includes("PASS");
      const smokeResult: QmSmokeResult = {
        status: passed ? "pass" : "fail",
        checkedAt: deps.now(),
        message: passed ? null : smokeFailureMessage(result)
      };

      if (cachedStatus?.state === "ready") {
        return updateCachedStatus(readyStatus(
          cachedStatus.contract,
          cachedStatus.doctor,
          smokeResult,
          cachedStatus.qmCliVersion
        ));
      }

      return updateCachedStatus(makeQmNotCheckedStatus(smokeResult));
    } finally {
      releaseOperation();
    }
  }

  return { runValidate, runSmoke, getCachedQmStatus };
}

/* ── Public API (production singleton, real dependencies) ───── */

const defaultRunner = createQmRunner();

export const runValidate: () => Promise<QmSystemStatus> = defaultRunner.runValidate;
export const runSmoke: () => Promise<QmStatusResponse> = defaultRunner.runSmoke;
export const getCachedQmStatus: () => QmStatusResponse | null = defaultRunner.getCachedQmStatus;
