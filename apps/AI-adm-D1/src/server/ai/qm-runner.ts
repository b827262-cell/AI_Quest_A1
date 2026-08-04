import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { QmSystemStatus, QmContractResult, QmDoctorResult, QmSmokeResult, QmDoctorBlocker } from "@ai-smartbook/contracts";
import { deriveOverallStatus } from "@ai-smartbook/contracts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "../../../../..");
const DEPLOY_QM_DIR = resolve(PROJECT_ROOT, "deploy/qm");
const QM_BIN = resolve(DEPLOY_QM_DIR, "node_modules/.bin/qm");
const RUNNER_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8192;

/* ── Secret / path redaction ───────────────────────────────── */

const REDACT_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]"],
  [/sk-proj-[a-zA-Z0-9_-]+/g, "[REDACTED]"],
  [/sk-or-[a-zA-Z0-9_-]+/g, "[REDACTED]"],
  [/Bearer\s+[^\s"]+/g, "Bearer [REDACTED]"],
  [/=[^\s,]+/g, "=[REDACTED]"],          // strip values after = in env-like lines
  [/\/(?:home|Users|root)\/[^\s"]+/g, "[PATH]"],
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/* ── Contract parsing ──────────────────────────────────────── */

export function parseContractResult(stdout: string): QmContractResult {
  try {
    const raw = JSON.parse(stdout.trim());
    const result: QmContractResult = {
      valid: Boolean(raw.valid),
      version: typeof raw.contract === "number" ? raw.contract : 0,
      clauses: {}
    };
    if (raw.clauses && typeof raw.clauses === "object") {
      for (const [key, value] of Object.entries(raw.clauses as Record<string, Record<string, unknown>>)) {
        result.clauses[key] = {
          status: value.status === "pass" ? "pass" : "fail",
          errors: Array.isArray(value.errors) ? (value.errors as string[]).map(redactSecrets) : undefined,
          warnings: Array.isArray(value.warnings) ? (value.warnings as string[]).map(redactSecrets) : undefined,
          count: typeof value.count === "number" ? value.count : undefined,
          // Intentionally strip `names` (secret names list) for security
        };
      }
    }
    return result;
  } catch {
    return { valid: false, version: 0, clauses: {} };
  }
}

/* ── Doctor parsing ────────────────────────────────────────── */

export function parseDoctorResult(stdout: string, stderr: string, exitCode: number): QmDoctorResult {
  if (exitCode === 0) {
    return { status: "pass", exitCode: 0, blockers: [], message: null };
  }

  const combined = `${stdout}\n${stderr}`;
  const blockers: QmDoctorBlocker[] = [];

  // Detect bulk credential issues: "required secrets are missing or placeholders: NAME1, NAME2, ..."
  const credentialBulkMatch = combined.match(
    /required secrets? (?:are|is) missing(?: or placeholders?)?:\s*(.+)/i
  );
  if (credentialBulkMatch) {
    const names = credentialBulkMatch[1]
      .split(",")
      .map(s => s.trim())
      .filter(s => /^[A-Z][A-Z0-9_]+$/.test(s));  // Only keep env-var-shaped names
    blockers.push({
      category: "credential",
      code: "missing_or_placeholder",
      names,
      message: "Required secrets are missing or placeholders",
    });
  }

  // Detect individual secret issues: "OPENAI_API_KEY is missing" / "CORE_SIGNING_SECRET is still a placeholder"
  const individualPattern = /([A-Z][A-Z0-9_]+)\s+is\s+(?:missing|still a placeholder)/gi;
  const additionalNames: string[] = [];
  let match;
  while ((match = individualPattern.exec(combined)) !== null) {
    additionalNames.push(match[1]);
  }
  if (additionalNames.length > 0 && !credentialBulkMatch) {
    blockers.push({
      category: "credential",
      code: "missing_or_placeholder",
      names: additionalNames,
      message: "Required secrets are missing or placeholders",
    });
  }

  // Detect missing tools – ONLY when the output actually mentions a tool as missing
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
        message: `${tool} is not installed or not in PATH`,
      });
    }
  }

  // If nothing recognised, add unknown blocker
  if (blockers.length === 0) {
    blockers.push({
      category: "unknown",
      code: "doctor_failed",
      message: redactSecrets(combined.trim().slice(0, 300)),
    });
  }

  return {
    status: "blocked",
    exitCode,
    blockers,
    message: blockers.map(b => b.message).join("; "),
  };
}

/* ── In-memory state ───────────────────────────────────────── */

let cachedStatus: QmSystemStatus | null = null;
const runningOperations = new Set<string>();

/** Return the last computed status. Returns null before any validate/smoke has run. */
export function getCachedQmStatus(): QmSystemStatus | null {
  return cachedStatus;
}

/* ── Child process helper ──────────────────────────────────── */

function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number = RUNNER_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectP(new Error("command_timeout"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr: stderr + err.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/* ── Node 24 wrapper for QM CLI ────────────────────────────── */

function qmArgs(cliArgs: string[]): { command: string; args: string[] } {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major >= 24) {
    return { command: QM_BIN, args: cliArgs };
  }
  // Use the proven npx --package=node@24 wrapper
  return {
    command: "npx",
    args: ["--yes", "--package=node@24", "--", QM_BIN, ...cliArgs],
  };
}

/* ── Read pinned QM CLI version ────────────────────────────── */

function readQmCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(DEPLOY_QM_DIR, "package.json"), "utf8"));
    return pkg.dependencies?.["@yc-software/qm"] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/* ── Public API ────────────────────────────────────────────── */

/**
 * Run `qm check --json` and `qm doctor` in the deploy/qm directory.
 * Updates and returns the cached system status.
 */
export async function runValidate(): Promise<QmSystemStatus> {
  if (runningOperations.has("validate")) {
    throw new Error("operation_already_running: validate");
  }
  runningOperations.add("validate");

  try {
    if (!existsSync(QM_BIN)) {
      throw new Error("qm_cli_not_installed");
    }

    const { command: checkCmd, args: checkArgs } = qmArgs(["check", "--json"]);
    const checkResult = await spawnCapture(checkCmd, checkArgs, DEPLOY_QM_DIR);
    const contractResult = parseContractResult(checkResult.stdout);

    const { command: doctorCmd, args: doctorArgs } = qmArgs(["doctor"]);
    const doctorResult = await spawnCapture(doctorCmd, doctorArgs, DEPLOY_QM_DIR);
    const doctor = parseDoctorResult(doctorResult.stdout, doctorResult.stderr, doctorResult.exitCode);

    const qmCliVersion = readQmCliVersion();
    const checkedAt = new Date().toISOString();

    const smoke: QmSmokeResult = cachedStatus?.smoke ?? {
      status: "not_run",
      checkedAt: null,
      message: null
    };

    const overallStatus = deriveOverallStatus(contractResult, doctor, smoke);

    cachedStatus = {
      overallStatus,
      checkedAt,
      qmCliVersion,
      contract: contractResult,
      doctor,
      smoke
    };

    return cachedStatus;
  } finally {
    runningOperations.delete("validate");
  }
}

/**
 * Run the feedback workflow smoke test.
 * Updates the smoke portion of the cached status.
 */
export async function runSmoke(): Promise<QmSystemStatus> {
  if (runningOperations.has("smoke")) {
    throw new Error("operation_already_running: smoke");
  }
  runningOperations.add("smoke");

  try {
    const tsxLoader = resolve(PROJECT_ROOT, "apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs");
    const smokeScript = resolve(PROJECT_ROOT, "scripts/qm-feedback-smoke.ts");

    const result = await spawnCapture(
      process.execPath,
      ["--import", tsxLoader, smokeScript],
      PROJECT_ROOT
    );

    const passed = result.exitCode === 0 && result.stdout.includes("PASS");

    const smokeResult: QmSmokeResult = {
      status: passed ? "pass" : "fail",
      checkedAt: new Date().toISOString(),
      message: passed ? null : redactSecrets((result.stdout + "\n" + result.stderr).trim().slice(0, 200)),
    };

    if (cachedStatus) {
      cachedStatus = {
        ...cachedStatus,
        smoke: smokeResult,
        checkedAt: new Date().toISOString(),
        overallStatus: deriveOverallStatus(cachedStatus.contract, cachedStatus.doctor, smokeResult),
      };
    } else {
      // No prior validate — provide minimal structure
      cachedStatus = {
        overallStatus: "warning",
        checkedAt: new Date().toISOString(),
        qmCliVersion: readQmCliVersion(),
        contract: { valid: false, version: 0, clauses: {} },
        doctor: { status: "blocked", exitCode: -1, blockers: [], message: "Validation not yet run" },
        smoke: smokeResult,
      };
    }

    return cachedStatus;
  } finally {
    runningOperations.delete("smoke");
  }
}
