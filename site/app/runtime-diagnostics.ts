/**
 * Shared runtime diagnostics for the A-01 student home: one classifier that turns
 * any learner-facing failure into a stable machine code plus a retry policy, and
 * one build/runtime identity resolver used by both the browser and /api/health so
 * the two sides can never disagree about which version is on screen.
 */

export const APP_VERSION = "0.1.0";

export type IdentitySource = "environment" | "injected" | "fallback";

export type BuildIdentity = {
  version: string;
  buildId: string;
  gitSha: string;
  source: IdentitySource;
};

export type ConnectivityState = "online" | "offline" | "unknown";

export type RecoveryAction =
  | "retry"
  | "retry-with-scope"
  | "reconnect"
  | "switch-browser"
  | "re-download"
  | "handoff"
  | "none";

export type RuntimeDiagnosticCode =
  | "offline"
  | "network"
  | "timeout"
  | "cache-storage-unsupported"
  | "cache-quota"
  | "cache-corrupt"
  | "cache-incomplete"
  | "model-load-failed"
  | "model-scope-unsupported"
  | "subject-out-of-scope"
  | "low-confidence"
  | "generation-empty"
  | "generation-format-invalid"
  | "generation-format-unparsable"
  | "generation-failed"
  | "generation-unavailable"
  | "generation-cancelled"
  | "download-cancelled"
  | "download-stalled"
  | "unknown";

export type RuntimeDiagnostic = {
  code: RuntimeDiagnosticCode;
  retryable: boolean;
  recovery: RecoveryAction;
};

// Ordered most specific first: the first match wins, so a cancelled download that
// also mentions the cache must not be reported as a cache fault.
const RULES: ReadonlyArray<{
  code: RuntimeDiagnosticCode;
  retryable: boolean;
  recovery: RecoveryAction;
  match: RegExp;
}> = [
  { code: "offline", retryable: true, recovery: "reconnect", match: /處於離線狀態/ },
  { code: "download-cancelled", retryable: true, recovery: "retry", match: /已取消模型下載/ },
  { code: "generation-cancelled", retryable: true, recovery: "retry", match: /已取消本機 AI 回答/ },
  { code: "download-stalled", retryable: true, recovery: "re-download", match: /下載停滯/ },
  { code: "cache-storage-unsupported", retryable: false, recovery: "switch-browser", match: /不支援 Cache Storage/ },
  { code: "cache-quota", retryable: true, recovery: "re-download", match: /快取空間不足/ },
  { code: "cache-corrupt", retryable: true, recovery: "re-download", match: /快取檔案受損/ },
  { code: "cache-incomplete", retryable: true, recovery: "re-download", match: /下載未完整保存/ },
  { code: "model-load-failed", retryable: true, recovery: "re-download", match: /本機模型無法載入/ },
  { code: "generation-failed", retryable: true, recovery: "handoff", match: /本機 AI 模型無法完成回答/ },
  { code: "generation-unavailable", retryable: true, recovery: "retry", match: /本機 AI 暫時無法出題/ },
  { code: "model-scope-unsupported", retryable: false, recovery: "none", match: /僅支援 Auto 與 Qwen3-0\.6B/ },
  { code: "subject-out-of-scope", retryable: true, recovery: "retry-with-scope", match: /請輸入資訊或會計的學習主題/ },
  { code: "low-confidence", retryable: true, recovery: "retry-with-scope", match: /沒有足夠把握/ },
  { code: "generation-format-invalid", retryable: true, recovery: "retry", match: /未通過檢查/ },
  { code: "generation-format-unparsable", retryable: true, recovery: "retry", match: /出題格式無法解析/ },
  { code: "generation-empty", retryable: true, recovery: "retry", match: /沒有(完成出題|產生練習題)/ },
  { code: "timeout", retryable: true, recovery: "retry", match: /(<timeout>|timeout|timed out|逾時|超時)/i },
  { code: "network", retryable: true, recovery: "retry", match: /(<network>|failed to fetch|network(error| request)?|網路連線)(?![a-z])/i },
];

export const OFFLINE_COPY = "目前瀏覽器處於離線狀態，請確認網路連線後再送出一次。";

function textOf(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name} ${cause.message}`;
  if (cause == null) return "";
  return String(cause);
}

/**
 * Never throws: an unrecognised failure degrades to `unknown` with a retry hint so
 * the learner always gets a code that support can grep for.
 */
export function classifyRuntimeError(
  cause: unknown,
  options: { online?: boolean | null } = {},
): RuntimeDiagnostic {
  const online = options.online;
  if (online === false) {
    return { code: "offline", retryable: true, recovery: "reconnect" };
  }
  const text = textOf(cause).trim();
  if (!text) {
    return { code: "unknown", retryable: true, recovery: "retry" };
  }
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { code: rule.code, retryable: rule.retryable, recovery: rule.recovery };
    }
  }
  return { code: "unknown", retryable: true, recovery: "retry" };
}

export function resolveConnectivityState(online: boolean | null | undefined): ConnectivityState {
  if (online === true) return "online";
  if (online === false) return "offline";
  return "unknown";
}

/**
 * SSR-safe: a server render has no browser signal, so it must not claim offline.
 * Node also exposes `navigator`, so the signal is only trusted when the host
 * actually reports a boolean `onLine`.
 */
export function readBrowserConnectivity(): boolean | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const online = (navigator as { onLine?: unknown }).onLine;
  return typeof online === "boolean" ? online : null;
}

const GIT_SHA = /^[0-9a-f]{7,40}$/i;

function trimmed(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function normalizeGitSha(value: unknown): string | null {
  const raw = trimmed(value);
  return GIT_SHA.test(raw) ? raw.toLowerCase() : null;
}

export type InjectedIdentity = Partial<Pick<BuildIdentity, "version" | "buildId" | "gitSha">>;

/** Set at build time by an embedder; absent in a plain dev server. */
export function readInjectedIdentity(global: { __A01_BUILD_IDENTITY__?: InjectedIdentity } = globalThis as unknown as { __A01_BUILD_IDENTITY__?: InjectedIdentity }): InjectedIdentity {
  return global.__A01_BUILD_IDENTITY__ ?? {};
}

export type IdentityInput = {
  env?: Record<string, unknown> | undefined;
  injected?: InjectedIdentity;
};

export function resolveBuildIdentity({ env = {}, injected = readInjectedIdentity() }: IdentityInput = {}): BuildIdentity {
  const fromEnv = Boolean(trimmed(env.VERSION) || trimmed(env.BUILD_ID) || trimmed(env.GIT_SHA) || trimmed(env.COMMIT_SHA));
  const fromInjected = Boolean(trimmed(injected.version) || trimmed(injected.buildId) || trimmed(injected.gitSha));
  return {
    version: trimmed(env.VERSION) || trimmed(injected.version) || APP_VERSION,
    buildId: trimmed(env.BUILD_ID) || trimmed(injected.buildId) || "dev",
    gitSha: normalizeGitSha(env.GIT_SHA ?? env.COMMIT_SHA) ?? normalizeGitSha(injected.gitSha) ?? "unknown",
    source: fromEnv ? "environment" : fromInjected ? "injected" : "fallback",
  };
}

export function frontendBuildIdentity(): BuildIdentity {
  return resolveBuildIdentity({ injected: readInjectedIdentity() });
}

export type IdentityComparison = {
  consistent: boolean;
  undetermined: string[];
  mismatched: string[];
};

const INDETERMINATE: Record<string, string> = { buildId: "dev", gitSha: "unknown" };

/**
 * A mismatch only counts when both sides actually published a value. A dev or
 * pre-deploy build legitimately reports `dev`/`unknown`, and that must not be
 * flagged as a frontend/runtime version skew.
 */
export function compareBuildIdentity(local: BuildIdentity, remote: BuildIdentity): IdentityComparison {
  const undetermined: string[] = [];
  const mismatched: string[] = [];
  for (const key of ["version", "buildId", "gitSha"] as const) {
    const left = local[key];
    const right = remote[key];
    if (left === right) continue;
    if (left === INDETERMINATE[key] || right === INDETERMINATE[key] || !normalizeComparable(key, left) || !normalizeComparable(key, right)) {
      undetermined.push(key);
      continue;
    }
    mismatched.push(key);
  }
  return { consistent: mismatched.length === 0, undetermined, mismatched };
}

function normalizeComparable(key: "version" | "buildId" | "gitSha", value: string): string | null {
  if (key === "gitSha") return normalizeGitSha(value);
  return trimmed(value) || null;
}
