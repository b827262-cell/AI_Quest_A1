import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { artifactPath, releaseMetadata, scanArtifactText, sanitizeDiagnostic, writeSanitizedArtifact } from "./release-artifacts.mjs";

const reportPath = artifactPath("production-verification", "PRODUCTION_REPORT_PATH");
const studentBase = (process.env.PRODUCTION_STUDENT_BASE_URL || process.env.PRODUCTION_BASE_URL || "").trim().replace(/\/$/, "");
const adminBase = (process.env.PRODUCTION_ADMIN_BASE_URL || "").trim().replace(/\/$/, "");
const checks = [];

function record(name, state, endpoint, reason, status, ms) {
  checks.push({ name, state, endpoint, ...(status === undefined ? {} : { status }), ...(ms === undefined ? {} : { ms }), ...(reason ? { reason } : {}) });
}

function safeBody(body) {
  return !/sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|(?:authorization|x-admin-token|bearer)\s*[:=]|encrypted[_-]?api[_-]?key|key[_-]?fingerprint|stack trace|at\s+\S+\.(?:ts|js):\d+/i.test(body);
}

async function request(base, path, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
    const body = await response.text();
    return { response, body, status: response.status, ms: Date.now() - started };
  } catch {
    return { response: null, body: "", status: undefined, ms: Date.now() - started };
  }
}

async function httpCheck(name, base, path, expected, init = {}, bodyRequiredSafe = true) {
  if (!base) {
    record(name, "BLOCKED", path, "target base URL is not configured");
    return null;
  }
  const result = await request(base, path, init);
  const statusOk = result.status !== undefined && expected.includes(result.status);
  const safe = !bodyRequiredSafe || safeBody(result.body);
  record(name, statusOk && safe ? "PASS" : "FAIL", path, statusOk ? (safe ? undefined : "response contained unsafe internal material") : `expected ${expected.join("/")}`, result.status, result.ms);
  return result;
}

function localHttpBase(httpsBase) {
  try {
    const url = new URL(httpsBase);
    if (url.protocol !== "https:") return undefined;
    url.protocol = "http:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function nginxCheck() {
  if (!studentBase || !adminBase) {
    record("nginx -t", "BLOCKED", "host command", "production target URLs are not configured; local config is not treated as production evidence");
    return null;
  }
  const binary = process.env.PRODUCTION_NGINX_BIN?.trim() || "nginx";
  try {
    execFileSync(binary, ["-t"], { stdio: "ignore", timeout: 15_000 });
    record("nginx -t", "PASS", "host command");
    return true;
  } catch (error) {
    const code = error?.code === "ENOENT" ? "nginx executable unavailable on target runner" : "nginx configuration test failed";
    record("nginx -t", error?.code === "ENOENT" ? "BLOCKED" : "FAIL", "host command", code);
    return false;
  }
}

function effectiveConfigCheck() {
  const configPath = process.env.PRODUCTION_NGINX_EFFECTIVE_CONFIG?.trim();
  if (!configPath) {
    record("Nginx effective config has no permanent Admin token injection", "BLOCKED", "host config", "set PRODUCTION_NGINX_EFFECTIVE_CONFIG to a protected, operator-produced nginx -T snapshot");
    record("Nginx body size and AI timeout directives", "BLOCKED", "host config", "effective config snapshot unavailable");
    return;
  }
  try {
    const content = readFileSync(configPath, "utf8");
    if (!scanArtifactText(content).passed) {
      record("Nginx effective config has no permanent Admin token injection", "FAIL", "host config", "effective config contains secret material");
      return;
    }
    const permanentTokenInjection = /proxy_set_header\s+(?:X-Admin-Token|Authorization)\s+(?!""\s*;)(?:"[^";]+"|\$[A-Za-z_][A-Za-z0-9_]*)\s*;/i.test(content);
    record("Nginx effective config has no permanent Admin token injection", permanentTokenInjection ? "FAIL" : "PASS", "host config", permanentTokenInjection ? "reverse proxy injects or forwards a non-empty Admin token header" : undefined);
    const bodyAndTimeout = /client_max_body_size\s+[^;]+;/.test(content) && /proxy_(?:read|send)_timeout\s+[^;]+;/.test(content);
    record("Nginx body size and AI timeout directives", bodyAndTimeout ? "PASS" : "FAIL", "host config", bodyAndTimeout ? undefined : "client body limit or proxy timeout directive was not found");
  } catch {
    record("Nginx effective config has no permanent Admin token injection", "BLOCKED", "host config", "effective config snapshot could not be read");
    record("Nginx body size and AI timeout directives", "BLOCKED", "host config", "effective config snapshot could not be read");
  }
}

async function tlsCheck() {
  if (!studentBase || !adminBase) {
    record("TLS certificate validity", "BLOCKED", "https listener", "production target URLs are not configured");
    return;
  }
  for (const [name, base] of [["Student TLS certificate", studentBase], ["Admin TLS certificate", adminBase]]) {
    try {
      const url = new URL(base);
      if (url.protocol !== "https:") {
        record(name, "FAIL", "https listener", "target URL is not HTTPS");
        continue;
      }
      await new Promise((resolveProbe) => {
        const socket = tlsConnect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: true, timeout: 10_000 });
        let settled = false;
        const finish = (state, reason) => {
          if (settled) return;
          settled = true;
          record(name, state, "https listener", reason);
          socket.destroy();
          resolveProbe();
        };
        socket.once("secureConnect", () => {
          const certificate = socket.getPeerCertificate();
          const validUntil = certificate.valid_to ? Date.parse(certificate.valid_to) : 0;
          finish(validUntil > Date.now() ? "PASS" : "FAIL", validUntil > Date.now() ? undefined : "certificate is missing or expired");
        });
        socket.once("error", () => finish("FAIL", "TLS connection failed"));
        socket.once("timeout", () => finish("BLOCKED", "TLS connection timed out"));
      });
    } catch {
      record(name, "FAIL", "https listener", "TLS target could not be parsed");
    }
  }
}

async function portIsolationCheck() {
  if (!studentBase) {
    record("4300 public network isolation", "BLOCKED", "tcp/4300", "production student URL is not configured");
    return;
  }
  try {
    const url = new URL(studentBase);
    const result = await new Promise((resolveResult) => {
      const socket = tcpConnect({ host: url.hostname, port: 4300, timeout: 5_000 });
      socket.once("connect", () => { socket.destroy(); resolveResult("OPEN"); });
      socket.once("timeout", () => { socket.destroy(); resolveResult("TIMEOUT"); });
      socket.once("error", (error) => resolveResult(error.code === "ECONNREFUSED" ? "CLOSED" : "ERROR"));
    });
    record("4300 public network isolation", result === "CLOSED" ? "PASS" : result === "OPEN" ? "FAIL" : "BLOCKED", "tcp/4300", result === "CLOSED" || result === "OPEN" ? undefined : "port probe was inconclusive");
  } catch {
    record("4300 public network isolation", "BLOCKED", "tcp/4300", "target host could not be parsed");
  }
}

function tokenFile() {
  const file = process.env.PRODUCTION_ADMIN_TOKEN_FILE?.trim();
  if (!file) return undefined;
  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      record("Admin token file permissions", "FAIL", "protected token file", "token file is accessible by group or other users");
      return undefined;
    }
    const value = readFileSync(file, "utf8").trim();
    if (!value) {
      record("Admin token file permissions", "FAIL", "protected token file", "token file is empty");
      return undefined;
    }
    record("Admin token file permissions", "PASS", "protected token file");
    return value;
  } catch {
    record("Admin token file permissions", "BLOCKED", "protected token file", "protected token file is unavailable");
    return undefined;
  }
}

async function run() {
  if (!studentBase || !adminBase) {
    record("Production target prerequisites", "BLOCKED", "target URLs", "set PRODUCTION_STUDENT_BASE_URL and PRODUCTION_ADMIN_BASE_URL in the controlled runner; no target network was contacted");
  } else {
    await httpCheck("Student HTTPS frontend", studentBase, "/", [200]);
    await httpCheck("Admin HTTPS frontend", adminBase, "/", [200]);
    const httpBase = localHttpBase(studentBase);
    if (httpBase) {
      const redirect = await request(httpBase, "/");
      const location = redirect.response?.headers.get("location") || "";
      record("HTTP redirects to HTTPS", [301, 302, 303, 307, 308].includes(redirect.status) && /^https:\/\//i.test(location) ? "PASS" : "FAIL", "/", "HTTP redirect did not point to HTTPS", redirect.status, redirect.ms);
    } else {
      record("HTTP redirects to HTTPS", "BLOCKED", "/", "student target is not an HTTPS URL from which an HTTP probe can be derived");
    }
    await httpCheck("Public site config", studentBase, "/api/public/site-config", [200]);
    await httpCheck("Student domain rejects Admin API", studentBase, "/api/admin/ai-providers", [404]);
    await httpCheck("Admin unauthorized request is rejected", adminBase, "/api/admin/ai-analytics/summary", [401, 403, 404, 503], { headers: {} });
    await httpCheck("Unauthorized CORS origin is rejected", adminBase, "/api/admin/ai-analytics/summary", [401, 403, 404, 503], { headers: { Origin: "https://unauthorized.invalid" } });
    await httpCheck("Forwarded-header spoof does not grant Admin access", adminBase, "/api/admin/ai-analytics/summary", [401, 403, 404, 503], { headers: { "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Proto": "https" } });
    const security = await httpCheck("Security headers", adminBase, "/", [200]);
    const securityHeaders = security?.response?.headers;
    if (securityHeaders) {
      const hasRequired = Boolean(securityHeaders.get("x-content-type-options")) && (new URL(adminBase).protocol !== "https:" || Boolean(securityHeaders.get("strict-transport-security")));
      record("Security headers are present", hasRequired ? "PASS" : "FAIL", "/", hasRequired ? undefined : "required security header missing");
    }
    const adminToken = tokenFile();
    if (adminToken) {
      const authorized = await httpCheck("Admin token reaches protected API", adminBase, "/api/admin/ai-analytics/summary", [200], { headers: { "X-Admin-Token": adminToken } });
      const setCookie = authorized?.response?.headers.get("set-cookie");
      if (setCookie) {
        const cookieSafe = /\bsecure\b/i.test(setCookie) && /\bhttponly\b/i.test(setCookie) && /\bsamesite=(?:strict|lax|none)\b/i.test(setCookie);
        record("Admin cookie flags", cookieSafe ? "PASS" : "FAIL", "protected response", cookieSafe ? undefined : "Secure/HttpOnly/SameSite flags are incomplete");
      } else {
        record("Admin cookie flags", "BLOCKED", "protected response", "protected response did not set a session cookie to inspect");
      }
    } else {
      record("Admin token reaches protected API", "BLOCKED", "/api/admin/ai-analytics/summary", "inject token through PRODUCTION_ADMIN_TOKEN_FILE for a controlled authorized probe");
      record("Admin cookie flags", "BLOCKED", "protected response", "authorized session probe was not run");
    }
    await httpCheck("Uploads routing remains bounded", studentBase, "/uploads/books/test.pdf", [200, 403, 404]);
    await httpCheck("Error responses are sanitized", adminBase, "/api/does-not-exist-phase3a", [404], {}, true);
  }

  nginxCheck();
  effectiveConfigCheck();
  await tlsCheck();
  await portIsolationCheck();

  const logPaths = [process.env.PRODUCTION_APP_LOG_PATH, process.env.PRODUCTION_NGINX_LOG_PATH].filter(Boolean);
  if (logPaths.length === 2) {
    let clean = true;
    for (const path of logPaths) {
      try {
        const content = readFileSync(path, "utf8").slice(-1_000_000);
        if (!scanArtifactText(content).passed) clean = false;
      } catch {
        clean = false;
      }
    }
    record("Application and Nginx log secret scan", clean ? "PASS" : "FAIL", "log tail", clean ? undefined : "secret marker detected or log could not be read");
  } else {
    record("Application and Nginx log secret scan", "BLOCKED", "log tail", "set both protected log paths for a read-only scan");
  }
  record("Missing Master Key fails closed", "BLOCKED", "approved restart probe", "requires an approved target restart without AI_CREDENTIAL_ENCRYPTION_KEY; runner never changes production configuration");
  record("Credential disable/revocation is effective", "BLOCKED", "approved credential probe", "requires a pre-approved target credential and cleanup window; no production mutation was attempted");
  record("Rollback restore rehearsal", "BLOCKED", "approved maintenance window", "requires operator-run backup restore rehearsal; runner does not alter production data");

  const failed = checks.filter((check) => check.state === "FAIL").length;
  const blocked = checks.filter((check) => check.state === "BLOCKED").length;
  const status = failed > 0 ? "FAIL" : blocked > 0 ? "BLOCKED" : "PASS";
  const artifact = writeSanitizedArtifact(reportPath, {
    ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "production"),
    status,
    checks,
    securityHeaders: checks.filter((check) => check.name.toLowerCase().includes("security")),
    secretLeakageScan: "PASS"
  });
  const finalStatus = artifact.written ? status : "FAIL";
  const finalExit = finalStatus === "PASS" ? 0 : finalStatus === "BLOCKED" ? 2 : 1;
  for (const check of checks) console.log(`[${check.state}] ${check.name} — ${check.endpoint}${check.status === undefined ? "" : ` HTTP ${check.status}`}${check.reason ? ` — ${sanitizeDiagnostic(check.reason)}` : ""}`);
  console.log(`Production verification: ${finalStatus} (PASS=${checks.filter((check) => check.state === "PASS").length}, FAIL=${failed}, BLOCKED=${blocked})`);
  console.log(`Sanitized report: ${artifact.written ? reportPath : "unavailable (safe write/leakage scan failed)"}`);
  process.exitCode = finalExit;
  return finalExit;
}

void run().catch(() => {
  console.error("Production verification: FAIL (details redacted)");
  process.exitCode = 1;
});
