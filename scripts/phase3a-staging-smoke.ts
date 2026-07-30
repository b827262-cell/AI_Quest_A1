import { artifactPath, releaseMetadata, writeSanitizedArtifact } from "./release-artifacts.mjs";

type CheckState = "PASS" | "FAIL" | "BLOCKED";
type Check = { name: string; endpoint: string; state: CheckState; status?: number; ms?: number; reason?: string };
type HttpResult = { response: Response | null; body: string; status: number | undefined; ms: number; error?: string };

const checks: Check[] = [];
const publicBase = process.env.STAGING_BASE_URL?.trim().replace(/\/$/, "");
const studentBase = (process.env.STAGING_STUDENT_BASE_URL?.trim() || publicBase)?.replace(/\/$/, "");
const adminBase = (process.env.STAGING_ADMIN_BASE_URL?.trim() || "").replace(/\/$/, "");
const directApiBase = (process.env.STAGING_DIRECT_API_BASE_URL?.trim() || "").replace(/\/$/, "");
const adminToken = process.env.STAGING_ADMIN_TOKEN?.trim();
const mutate = process.env.PHASE3A_SMOKE_MUTATE === "true";
const runAi = process.env.PHASE3A_SMOKE_RUN_AI === "true";
const runLimits = process.env.PHASE3A_SMOKE_RUN_LIMITS === "true";
const reportPath = artifactPath("staging-smoke", "PHASE3A_SMOKE_REPORT");

function record(check: Check): void {
  checks.push(check);
}

function blocked(name: string, endpoint: string, reason: string): void {
  record({ name, endpoint, state: "BLOCKED", reason });
}

function safeResponse(body: string): boolean {
  return !/sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|(?:authorization|x-admin-token)\s*[:=]|encrypted[_-]?api[_-]?key|key[_-]?fingerprint|\bapiKey\b|stack trace|at\s+\S+\.(?:ts|js):\d+/i.test(body);
}

async function request(base: string, path: string, init?: RequestInit): Promise<HttpResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      ...init
    });
    return { response, body: await response.text(), status: response.status, ms: Date.now() - started };
  } catch {
    return { response: null, body: "", status: undefined, ms: Date.now() - started, error: "request failed" };
  }
}

function headers(withToken = true): HeadersInit {
  return withToken && adminToken ? { "x-admin-token": adminToken } : {};
}

async function checkHttp(
  name: string,
  base: string | undefined,
  path: string,
  expected: number[],
  init?: RequestInit,
  requireSafe = true
): Promise<HttpResult | null> {
  if (!base) {
    blocked(name, path, "staging base URL is not configured");
    return null;
  }
  const result = await request(base, path, init);
  const safe = !requireSafe || safeResponse(result.body);
  const ok = result.status !== undefined && expected.includes(result.status) && safe;
  record({
    name,
    endpoint: path,
    state: ok ? "PASS" : "FAIL",
    status: result.status,
    ms: result.ms,
    reason: ok ? undefined : result.error || (!safe ? "response safety scan failed" : `expected ${expected.join("/")}`)
  });
  return result;
}

function parseJson<T>(result: HttpResult | null): T | null {
  if (!result || !result.body) return null;
  try { return JSON.parse(result.body) as T; } catch { return null; }
}

async function run(): Promise<void> {
  if (!publicBase) {
    blocked("Staging smoke prerequisites", "(no URL)", "set STAGING_BASE_URL; no network request was attempted");
    printReport(2);
    return;
  }

  await checkHttp("Student frontend", studentBase, "/", [200]);
  await checkHttp("Public site config", publicBase, "/api/public/site-config", [200]);
  await checkHttp("Public guest-ask invalid input", publicBase, "/api/public/guest-ask", [400], {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  let guestRequestId: string | undefined;
  if (runAi) {
    const guest = await checkHttp("Public guest-ask AI request", publicBase, "/api/public/guest-ask", [200], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "請只回答 OK", providerPreference: "auto" })
    });
    guestRequestId = parseJson<{ requestId?: string }>(guest)?.requestId;
    if (guest && guest.status === 200 && !safeResponse(guest.body)) {
      record({ name: "Guest response secret scan", endpoint: "/api/public/guest-ask", state: "FAIL", status: guest.status, ms: guest.ms, reason: "response safety scan failed" });
    }
  } else {
    blocked("Public guest-ask AI request", "/api/public/guest-ask", "set PHASE3A_SMOKE_RUN_AI=true to spend a staging AI request");
  }
  if (runLimits && runAi) {
    await checkHttp("Public rate-limit/quota boundary", publicBase, "/api/public/guest-ask", [429], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "請只回答 OK", providerPreference: "auto" })
    });
  } else {
    blocked("Public rate-limit/quota/budget boundary", "/api/public/guest-ask", "set PHASE3A_SMOKE_RUN_AI=true and PHASE3A_SMOKE_RUN_LIMITS=true in an isolated staging quota");
  }

  const booksResult = await checkHttp("Student book list", studentBase, "/api/student/books", [200]);
  const books = parseJson<{ books?: Array<{ id: string }> }>(booksResult)?.books ?? [];
  const bookId = books[0]?.id;
  if (!bookId) {
    blocked("Student book detail/PDF/progress/knowledge regression", "/api/student/books/:bookId", "staging returned no published book to test without creating data");
  } else {
    const detailResult = await checkHttp("Student single-book page data", studentBase, `/api/student/books/${encodeURIComponent(bookId)}`, [200]);
    const detail = parseJson<{ files?: Array<{ id: string; fileType?: string; fileName?: string }> }>(detailResult);
    await checkHttp("Student book contents", studentBase, `/api/student/books/${encodeURIComponent(bookId)}/contents`, [200]);
    await checkHttp("Student progress panel", studentBase, `/api/student/books/${encodeURIComponent(bookId)}/progress-summary`, [200]);
    await checkHttp("Student knowledge-point panel", studentBase, `/api/student/books/${encodeURIComponent(bookId)}/knowledge-points`, [200]);
    const pdf = detail?.files?.find((file) => file.fileType === "application/pdf" || file.fileName?.toLowerCase().endsWith(".pdf"));
    if (pdf) {
      await checkHttp("Student PDF access", studentBase, `/api/student/books/${encodeURIComponent(bookId)}/files/${encodeURIComponent(pdf.id)}/pdf-view`, [200, 206]);
    } else {
      blocked("Student PDF access", "/api/student/books/:bookId/files/:fileId/pdf-view", "book has no PDF file available for a read-only check");
    }
  }

  if (!adminBase) {
    blocked("Admin frontend", "(admin base URL)", "set STAGING_ADMIN_BASE_URL; admin is intentionally not inferred from the student domain");
    blocked("Admin API smoke", "/api/admin/*", "set STAGING_ADMIN_BASE_URL");
  } else {
    await checkHttp("Admin frontend", adminBase, "/", [200]);
    const authProbeBase = directApiBase || adminBase;
    if (directApiBase) {
      await checkHttp("Admin API without token is rejected", authProbeBase, "/api/admin/ai-analytics/summary", [401, 403, 503], { headers: {} });
    } else {
      blocked("Admin API without token is rejected", "/api/admin/ai-analytics/summary", "set STAGING_DIRECT_API_BASE_URL to bypass any trusted Nginx token injection");
    }
    if (adminToken || directApiBase) {
      const adminHeaders = headers(true);
      await checkHttp("Admin analytics with authorization", adminBase, "/api/admin/ai-analytics/summary", [200], { headers: adminHeaders });
      const providersResult = await checkHttp("Admin Provider list", adminBase, "/api/admin/ai-providers", [200], { headers: adminHeaders });
      const providers = parseJson<{ providers?: Array<{ id: string; provider: string; enabled: boolean; displayName: string; priority: number }> }>(providersResult)?.providers ?? [];
      const providerId = process.env.STAGING_SMOKE_PROVIDER_ID?.trim() || providers[0]?.id;
      if (providerId) {
        const credentialsResult = await checkHttp("Admin Credential list is masked", adminBase, `/api/admin/ai-providers/${encodeURIComponent(providerId)}/credentials`, [200], { headers: adminHeaders });
        const credentialBody = credentialsResult?.body ?? "";
        if (credentialsResult && !safeResponse(credentialBody)) {
          record({ name: "Credential response secret scan", endpoint: "/api/admin/ai-providers/:id/credentials", state: "FAIL", status: credentialsResult.status, ms: credentialsResult.ms, reason: "credential response contained forbidden material" });
        }
        await checkHttp("Admin budget policies", adminBase, "/api/admin/ai-budget-policies", [200], { headers: adminHeaders });
        await checkHttp("Admin request logs", adminBase, "/api/admin/ai-requests?limit=1", [200], { headers: adminHeaders });
        if (guestRequestId) {
          await checkHttp("Usage/request detail is available without secrets", adminBase, `/api/admin/ai-requests/${encodeURIComponent(guestRequestId)}`, [200, 404], { headers: adminHeaders });
        } else {
          blocked("Usage/request detail verification", "/api/admin/ai-requests/:requestId", "guest AI smoke did not run");
        }
        await checkHttp("Admin invalid Provider payload", adminBase, "/api/admin/ai-providers", [400], { method: "POST", headers: { ...adminHeaders, "content-type": "application/json" }, body: "{}" });
        await runMutatingChecks(adminBase, adminHeaders, providers, providerId);
      } else {
        blocked("Admin Credential list", "/api/admin/ai-providers/:id/credentials", "no Provider exists and no STAGING_SMOKE_PROVIDER_ID was supplied");
        blocked("Provider/Credential mutation flow", "/api/admin/ai-providers", "no Provider exists for a non-destructive staging check");
      }
    } else {
      blocked("Admin API with authorization", "/api/admin/*", "set STAGING_ADMIN_TOKEN or use a configured trusted admin proxy");
    }
    await checkHttp("Unauthorized admin CORS origin rejected", adminBase, "/api/admin/ai-analytics/summary", [403], {
      headers: { Origin: "https://unauthorized.invalid" }
    });
  }
  await checkHttp("Security headers", publicBase, "/", [200], undefined, false).then((result) => {
    if (result && !result.response?.headers.get("x-content-type-options")) {
      record({ name: "Security headers", endpoint: "/", state: "FAIL", status: result.status, ms: result.ms, reason: "X-Content-Type-Options missing" });
    }
  });
  await checkHttp("Existing uploads/books/test.pdf rule", studentBase, "/uploads/books/test.pdf", [200, 403, 404]);
  printReport(checks.some((check) => check.state === "FAIL") ? 1 : checks.some((check) => check.state === "BLOCKED") ? 2 : 0);
}

async function runMutatingChecks(base: string, adminHeaders: HeadersInit, providers: Array<{ id: string; provider: string; enabled: boolean; displayName: string; priority: number }>, providerId: string): Promise<void> {
  if (!mutate) {
    blocked("Provider update/enable/disable flow", `/api/admin/ai-providers/${providerId}`, "set PHASE3A_SMOKE_MUTATE=true; default smoke is read-only");
    blocked("Credential create/test/disable flow", `/api/admin/ai-providers/${providerId}/credentials`, "set PHASE3A_SMOKE_MUTATE=true and provide a staging-only key through STAGING_SMOKE_CREDENTIAL_KEY");
    return;
  }
  const provider = providers.find((row) => row.id === providerId);
  if (!provider) {
    blocked("Provider update/enable/disable flow", `/api/admin/ai-providers/${providerId}`, "configured Provider ID was not returned by the server");
    return;
  }
  const contentHeaders = { ...adminHeaders, "content-type": "application/json" };
  const providerPayload = { provider: provider.provider, displayName: provider.displayName, enabled: provider.enabled, priority: provider.priority };
  await checkHttp("Provider create/upsert flow", base, "/api/admin/ai-providers", [201], { method: "POST", headers: contentHeaders, body: JSON.stringify(providerPayload) });
  await checkHttp("Provider update flow", base, "/api/admin/ai-providers", [200, 201], { method: "PUT", headers: contentHeaders, body: JSON.stringify(providerPayload) });
  await checkHttp("Provider disable flow", base, "/api/admin/ai-providers", [200, 201], { method: "PUT", headers: contentHeaders, body: JSON.stringify({ ...providerPayload, enabled: false }) });
  await checkHttp("Provider re-enable flow", base, "/api/admin/ai-providers", [200, 201], { method: "PUT", headers: contentHeaders, body: JSON.stringify(providerPayload) });

  const smokeKey = process.env.STAGING_SMOKE_CREDENTIAL_KEY?.trim();
  if (!smokeKey) {
    blocked("Credential create/test/disable flow", `/api/admin/ai-providers/${providerId}/credentials`, "STAGING_SMOKE_CREDENTIAL_KEY is unavailable; no credential mutation attempted");
    return;
  }
  let createdId: string | undefined;
  try {
    const created = await checkHttp("Credential create flow", base, `/api/admin/ai-providers/${encodeURIComponent(providerId)}/credentials`, [201], { method: "POST", headers: contentHeaders, body: JSON.stringify({ name: `phase3a-smoke-${Date.now()}`, apiKey: smokeKey, status: "standby", priority: 9999, weight: 1 }) });
    const body = parseJson<{ credential?: { id?: string } }>(created);
    createdId = body?.credential?.id;
    if (!createdId) blocked("Credential cleanup", "/api/admin/ai-credentials/:credentialId", "create response did not expose a safe credential id");
    if (createdId) {
      await checkHttp("Credential test flow", base, `/api/admin/ai-credentials/${encodeURIComponent(createdId)}/test`, [200, 503], { method: "POST", headers: adminHeaders });
      await checkHttp("Credential disable flow", base, `/api/admin/ai-credentials/${encodeURIComponent(createdId)}/disable`, [200], { method: "POST", headers: adminHeaders });
      await checkHttp("Credential enable flow", base, `/api/admin/ai-credentials/${encodeURIComponent(createdId)}/enable`, [200], { method: "POST", headers: adminHeaders });
    }
  } finally {
    if (createdId) await checkHttp("Credential soft-delete cleanup", base, `/api/admin/ai-credentials/${encodeURIComponent(createdId)}`, [204], { method: "DELETE", headers: adminHeaders });
  }
}

function printReport(exitCode: number): void {
  const counts = checks.reduce<Record<CheckState, number>>((result, check) => {
    result[check.state] += 1;
    return result;
  }, { PASS: 0, FAIL: 0, BLOCKED: 0 });
  console.log("Phase 3A staging smoke");
  for (const check of checks) {
    const timing = check.ms === undefined ? "" : ` ${check.ms}ms`;
    const status = check.status === undefined ? "" : ` HTTP ${check.status}`;
    console.log(`[${check.state}] ${check.name} — ${check.endpoint}${status}${timing}${check.reason ? ` — ${check.reason}` : ""}`);
  }
  console.log(`Summary: PASS=${counts.PASS} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED}`);
  const cleanupChecks = checks.filter((check) => check.name.toLowerCase().includes("cleanup"));
  const cleanup = !mutate ? "NOT RUN" : cleanupChecks.length > 0 && cleanupChecks.every((check) => check.state === "PASS") ? "PASS" : cleanupChecks.some((check) => check.state === "FAIL") ? "FAIL" : "BLOCKED";
  const artifact = writeSanitizedArtifact(reportPath, {
    ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "staging"),
    status: exitCode === 0 ? "PASS" : exitCode === 1 ? "FAIL" : "BLOCKED",
    checks,
    cleanup,
    securityHeaders: checks.filter((check) => check.name.toLowerCase().includes("security header")),
    secretLeakageScan: "PASS"
  });
  const effectiveExitCode = artifact.written ? exitCode : 1;
  console.log(artifact.written ? `Sanitized report: ${reportPath}` : "Sanitized report: blocked because leakage scan or safe write failed");
  if (effectiveExitCode === 2) console.log("Staging smoke status: BLOCKED (environment or explicit staging permission is missing)");
  if (effectiveExitCode === 1) console.log("Staging smoke status: FAIL");
  if (effectiveExitCode === 0) console.log("Staging smoke status: PASS");
  process.exitCode = effectiveExitCode;
}

void run().catch(() => {
  console.error("Phase 3A staging smoke: FAIL (details redacted)");
  process.exitCode = 1;
});
