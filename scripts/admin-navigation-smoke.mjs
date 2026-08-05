import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  artifactPath,
  releaseMetadata,
  sanitizeDiagnostic,
  writeSanitizedArtifact
} from "./release-artifacts.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const adminAppDir = join(root, "apps", "AI-adm-D1");

const apiPort = Number(process.env.ADMIN_NAV_SMOKE_API_PORT || 4311);
const webPort = Number(process.env.ADMIN_NAV_SMOKE_WEB_PORT || 5182);
// Local-only dev password fallback, identical to the public default documented
// in apps/AI-adm-D1/src/server/ai/admin-auth.ts (DEFAULT_ADMIN_DEV_PASSWORD).
// Never printed, logged, or written to any artifact by this script.
const adminPassword = process.env.ADMIN_NAV_SMOKE_PASSWORD?.trim() || "827827";
const e2eTimeoutMs = Math.max(5_000, Math.min(180_000, Number(process.env.E2E_TIMEOUT_MS || 30_000)));
const readyTimeoutMs = Math.max(5_000, Math.min(120_000, Number(process.env.ADMIN_NAV_SMOKE_READY_TIMEOUT_MS || 45_000)));
const configuredChrome = process.env.E2E_CHROME_EXECUTABLE?.trim() || process.env.CHROME_BIN?.trim();
const chromeCandidates = (configuredChrome ? [configuredChrome] : ["google-chrome", "chromium", "/snap/bin/chromium"]).filter(Boolean);
const allowNoSandbox = /^(?:1|true|yes)$/i.test(process.env.E2E_CHROME_NO_SANDBOX || "");
const reportPath = artifactPath("admin-navigation-smoke", "ADMIN_NAV_SMOKE_REPORT_PATH");
const ROUNDS = 3;
const ROUTES = [
  "/admin",
  "/admin/accounts",
  "/admin/appearance",
  "/admin/site-config",
  "/admin/ai-analytics",
  "/admin/ai-providers",
  "/admin/ai-quota-center",
  "/admin/ai-quality-evaluations",
  "/admin/qm-status",
  "/admin/books",
  "/admin/books/new"
];
const REFRESH_ROUTES = ["/admin/ai-providers", "/admin/qm-status"];

function fail(message) {
  throw new Error(message);
}

class BrowserLaunchError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = "BrowserLaunchError";
    this.diagnostics = diagnostics;
  }
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      /* server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  const stopped = await new Promise((resolveStopped) => {
    const timer = setTimeout(() => resolveStopped(false), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStopped(true);
    });
  });
  if (!stopped && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return stopped;
}

function spawnApiServer(dbPath) {
  const env = {
    ...process.env,
    ADMIN_API_PORT: String(apiPort),
    SQLITE_PATH: dbPath,
    // The admin API's CORS/origin boundary (admin-origin.ts) only allows the
    // conventional dev port 5174 by default; this smoke deliberately runs on
    // an isolated port so it never collides with a real local dev server.
    ADMIN_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`
  };
  // Force the dev-password auth path for this isolated smoke run regardless
  // of what the ambient shell/.env has configured for ADMIN_API_TOKEN. This
  // mutates only the *child's* env object, never process.env itself.
  delete env.ADMIN_API_TOKEN;
  delete env.NODE_ENV;
  const loader = join(adminAppDir, "node_modules", "tsx", "dist", "loader.mjs");
  const entry = join(adminAppDir, "src", "server", "index.ts");
  return spawn(process.execPath, ["--import", loader, entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
}

function spawnWebServer() {
  const viteBin = join(adminAppDir, "node_modules", ".bin", "vite");
  const env = { ...process.env, ADMIN_API_TARGET: `http://127.0.0.1:${apiPort}` };
  return spawn(viteBin, ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: adminAppDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function collectOutput(child, sink) {
  const onData = (chunk) => {
    sink.text = `${sink.text}${String(chunk)}`.slice(-4000);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
}

function cdpClient(url) {
  return new Promise((resolveClient, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    socket.addEventListener("open", () => resolveClient({
      socket,
      onMessage(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      send(method, params = {}) {
        return new Promise((resolveCommand, rejectCommand) => {
          const commandId = ++id;
          pending.set(commandId, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id: commandId, method, params }));
        });
      },
      close() { socket.close(); }
    }));
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const command = pending.get(message.id);
        if (!command) return;
        pending.delete(message.id);
        if (message.error) command.reject(new Error(message.error.message));
        else command.resolve(message.result);
        return;
      }
      for (const listener of listeners) listener(message);
    });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket unavailable")));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.text || "browser evaluation failed");
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 10000) {
  const started = Date.now();
  const boundedTimeout = Math.min(timeoutMs, e2eTimeoutMs);
  while (Date.now() - started < boundedTimeout) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.value) return result.result.value;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`browser condition timed out: ${expression.slice(0, 100)}`);
}

/**
 * A page counts as "settled" only once it is done loading AND the admin fetch
 * interceptor is installed for the *current* document. Vite's dev client can
 * trigger its own async `location.reload()` (e.g. right after a dependency
 * re-optimization) independently of any reload we initiate; if that lands
 * between our checks, `document.readyState` briefly reports "complete" again
 * for the outgoing document while the incoming one hasn't run main.tsx yet.
 * Requiring the interceptor marker closes that gap — every fetch issued after
 * this resolves is guaranteed to go through the real interceptor.
 */
async function waitPageSettled(cdp, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(cdp, `(function () {
      const text = document.body.innerText;
      return {
        loading: /載入中/.test(text),
        path: location.pathname,
        length: text.length,
        interceptorInstalled: window.__aiQuestAdminFetchInstalled === true
      };
    })()`);
    if (!state.loading && state.interceptorInstalled) return state;
    await new Promise((r) => setTimeout(r, 150));
  }
  fail("page did not settle before timeout");
}

async function setValueById(cdp, id, value) {
  const expression = `(function () {
    const input = document.getElementById(${JSON.stringify(id)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
  if (!(await evaluate(cdp, expression))) fail(`input not found: ${id}`);
}

async function clickButtonByText(cdp, label) {
  const expression = `(function () {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if (!(await evaluate(cdp, expression))) fail(`button not found: ${label}`);
}

async function clickNavLink(cdp, href) {
  await waitFor(cdp, `Boolean(document.querySelector('a[href="${href}"]'))`, 10000);
  const expression = `(function () {
    const link = document.querySelector('a[href="${href}"]');
    if (!link) return false;
    link.click();
    return true;
  })()`;
  if (!(await evaluate(cdp, expression))) fail(`nav link not found: ${href}`);
}

async function getPageTarget(endpoint) {
  const parsed = new URL(endpoint);
  const response = await fetch(`http://127.0.0.1:${parsed.port}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) fail("Chrome page target unavailable");
  return target.webSocketDebuggerUrl;
}

async function launchChrome(profileDir) {
  const diagnostics = [];
  const launchArgs = [
    "--headless=new", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-crash-reporter", "--disable-breakpad", "--remote-allow-origins=*",
    "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank"
  ];
  if (allowNoSandbox) launchArgs.splice(1, 0, "--no-sandbox");
  for (const candidate of chromeCandidates) {
    if (!candidate) continue;
    const child = spawn(candidate, launchArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let spawnError = "";
    const endpoint = await new Promise((resolveEndpoint) => {
      const timer = setTimeout(() => resolveEndpoint(null), Math.min(8000, e2eTimeoutMs));
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4000);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
      });
      child.once("error", (error) => {
        spawnError = error.code === "ENOENT" ? "executable not found" : "process spawn failed";
        clearTimeout(timer);
        resolveEndpoint(null);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveEndpoint(null);
        diagnostics.push({
          executable: basename(candidate),
          exit: `${code ?? "null"}/${signal ?? "none"}`,
          error: spawnError || undefined,
          stderr: sanitizeDiagnostic(stderr)
        });
      });
    });
    if (endpoint) return { child, endpoint, diagnostics };
    await stopChild(child);
  }
  const last = diagnostics.at(-1);
  throw new BrowserLaunchError(
    `headless browser unavailable: ${last?.executable || "no candidate"} (${last?.exit || "not started"})`,
    diagnostics
  );
}

async function main() {
  let status = "PASS";
  let exitCode = 0;
  let failureReason;
  let workDir;
  let apiServer;
  let webServer;
  let browser;
  let cdp;
  const apiOutput = { text: "" };
  const webOutput = { text: "" };
  const networkEvents = [];
  let networkPhase = "startup";
  const assertions = [];
  const check = (name, condition) => {
    const state = condition ? "PASS" : "FAIL";
    assertions.push({ name, state });
    if (!condition) throw new Error(`assertion failed: ${name}`);
  };

  try {
    workDir = mkdtempSync(join(tmpdir(), "admin-nav-smoke-"));
    const dbPath = join(workDir, "smoke.db");
    const profileDir = join(workDir, "chrome-profile");

    apiServer = spawnApiServer(dbPath);
    collectOutput(apiServer, apiOutput);
    webServer = spawnWebServer();
    collectOutput(webServer, webOutput);

    const apiReady = await waitForHttp(`http://127.0.0.1:${apiPort}/api/appearance-settings`, readyTimeoutMs);
    if (!apiReady) fail(`admin API did not become ready on port ${apiPort} within ${readyTimeoutMs}ms`);
    const webReady = await waitForHttp(`http://127.0.0.1:${webPort}/`, readyTimeoutMs);
    if (!webReady) fail(`admin web dev server did not become ready on port ${webPort} within ${readyTimeoutMs}ms`);

    browser = await launchChrome(profileDir);
    cdp = await cdpClient(await getPageTarget(browser.endpoint));
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    cdp.onMessage((message) => {
      if (message.method !== "Network.responseReceived") return;
      const response = message.params?.response;
      if (!response?.url?.includes("/api/admin/")) return;
      let pathname = response.url;
      try { pathname = new URL(response.url).pathname; } catch { /* keep raw */ }
      const headers = response.headers || {};
      const authState = headers["X-Admin-Auth-State"] || headers["x-admin-auth-state"] || null;
      networkEvents.push({ phase: networkPhase, path: pathname, status: response.status, authState });
    });

    // --- Login with the controlled local dev password -----------------
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/admin/login` });
    await waitFor(cdp, `Boolean(document.getElementById("admin-password"))`);
    await setValueById(cdp, "admin-password", adminPassword);
    await clickButtonByText(cdp, "登入管理後台");
    await waitFor(cdp, `location.pathname === "/admin"`, 10000);
    await waitPageSettled(cdp);
    check("login succeeds and lands on /admin", true);

    networkPhase = "valid-session";

    // --- 3 rounds of full sidebar navigation ---------------------------
    let navigationCount = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      for (const route of ROUTES) {
        await clickNavLink(cdp, route);
        const state = await waitPageSettled(cdp);
        navigationCount += 1;
        check(`round ${round} ${route}: stayed on route (no bounce to /admin/login)`, state.path === route);
      }
    }

    const unexpectedAuthRequired = networkEvents.filter((e) => e.phase === "valid-session" && e.status === 401 && e.authState === "invalid");
    const anyUnexpected401 = networkEvents.filter((e) => e.phase === "valid-session" && e.status === 401);
    check("zero ADMIN_AUTH_REQUIRED responses during valid-session navigation", unexpectedAuthRequired.length === 0);
    check("zero unexpected 401 responses during valid-session navigation", anyUnexpected401.length === 0);

    const tokenPresentAfterNav = await evaluate(cdp, `Boolean(window.sessionStorage.getItem("ai-quest.admin-token"))`);
    check("session token still present after full navigation sweep", tokenPresentAfterNav === true);

    // --- Refresh persistence on representative pages -------------------
    for (const route of REFRESH_ROUTES) {
      await clickNavLink(cdp, route);
      await waitPageSettled(cdp);
      await cdp.send("Page.reload", {});
      await waitFor(cdp, `document.readyState === "complete" && Boolean(document.querySelector(".admin-sidebar"))`, 15000);
      const state = await waitPageSettled(cdp);
      check(`refresh on ${route} keeps the session (no bounce to /admin/login)`, state.path === route);
    }

    // --- Business-logic 404 (unmarked) must not invalidate the session -
    const businessErrorResult = await evaluate(cdp, `(async function () {
      const before = window.sessionStorage.getItem("ai-quest.admin-token");
      const res = await fetch("/api/admin/ai-evaluation-alerts/nav-smoke-nonexistent-id/acknowledge", { method: "POST" });
      const after = window.sessionStorage.getItem("ai-quest.admin-token");
      return { status: res.status, tokenUnchanged: before === after && Boolean(after) };
    })()`);
    check("unmarked business 404 does not clear the session", businessErrorResult.status === 404 && businessErrorResult.tokenUnchanged === true);

    // --- Real invalid-token invalidation: single clear, single redirect,
    //     no event storm across concurrent marked 401s -------------------
    await evaluate(cdp, `window.__navSmokeExpiredCount = 0;
      window.addEventListener("ai-quest:admin-auth-expired", () => { window.__navSmokeExpiredCount += 1; });
      window.sessionStorage.setItem("ai-quest.admin-token", "nav-smoke-corrupted-token");
      true;`);
    networkPhase = "invalid-token";
    const concurrentResult = await evaluate(cdp, `(async function () {
      const results = await Promise.all([
        fetch("/api/admin/qm/status"),
        fetch("/api/admin/ai-evaluation-alerts?status=open"),
        fetch("/api/admin/ai-evaluations/retention"),
        fetch("/api/admin/ai-evaluations/governance"),
        fetch("/api/admin/ai-pilot/production-readiness")
      ]);
      return { statuses: results.map((r) => r.status) };
    })()`);
    check("all 5 concurrent requests with an invalid token were rejected with 401", concurrentResult.statuses.every((s) => s === 401));
    await waitFor(cdp, `location.pathname === "/admin/login"`, 10000);
    const expiredCount = await evaluate(cdp, `window.__navSmokeExpiredCount`);
    check("exactly one session-expired event for 5 concurrent marked 401s", expiredCount === 1);
    const tokenAfterInvalidation = await evaluate(cdp, `window.sessionStorage.getItem("ai-quest.admin-token")`);
    check("token cleared after invalid-token invalidation", tokenAfterInvalidation === null);

    const invalidPhaseMarked = networkEvents.filter((e) => e.phase === "invalid-token" && e.status === 401 && e.authState === "invalid");
    check("all invalid-token responses carried the ADMIN_AUTH_REQUIRED marker", invalidPhaseMarked.length === 5);

    console.log(`[admin-navigation-smoke] navigations executed: ${navigationCount}, admin API responses observed: ${networkEvents.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown navigation smoke error";
    failureReason = sanitizeDiagnostic(message);
    if (error instanceof BrowserLaunchError) browser = { diagnostics: error.diagnostics };
    if (error instanceof BrowserLaunchError || /headless browser unavailable|DevTools|setsockopt|sandbox|Chrome executable/i.test(message)) {
      status = "BLOCKED";
      exitCode = 2;
    } else {
      status = "FAIL";
      exitCode = 1;
    }
  } finally {
    cdp?.close();
    const chromeCleaned = await stopChild(browser?.child, "chrome");
    const apiCleaned = await stopChild(apiServer, "admin-api");
    const webCleaned = await stopChild(webServer, "admin-web");
    let workDirCleaned = true;
    if (workDir) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { workDirCleaned = false; }
    }

    const counts = assertions.reduce((result, assertion) => {
      result[assertion.state] += 1;
      return result;
    }, { PASS: 0, FAIL: 0 });

    const artifact = writeSanitizedArtifact(reportPath, {
      ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "local"),
      status,
      routes: ROUTES,
      rounds: ROUNDS,
      assertions,
      assertionCounts: { executed: counts.PASS + counts.FAIL, passed: counts.PASS, failed: counts.FAIL },
      networkSummary: {
        adminApiResponsesObserved: networkEvents.length,
        statusCounts: networkEvents.reduce((acc, e) => {
          acc[e.status] = (acc[e.status] || 0) + 1;
          return acc;
        }, {})
      },
      browser: {
        executable: configuredChrome ? basename(configuredChrome) : "auto-detected",
        noSandbox: allowNoSandbox,
        diagnostics: browser?.diagnostics || []
      },
      serverDiagnostics: {
        api: sanitizeDiagnostic(apiOutput.text, 2000),
        web: sanitizeDiagnostic(webOutput.text, 2000)
      },
      cleanup: {
        chromeProcess: chromeCleaned ? "PASS" : "FAIL",
        apiServer: apiCleaned ? "PASS" : "FAIL",
        webServer: webCleaned ? "PASS" : "FAIL",
        temporaryData: workDirCleaned ? "PASS" : "FAIL"
      },
      blockedReason: failureReason
    });
    if (!artifact.written) {
      status = "FAIL";
      exitCode = 1;
      console.error("Admin navigation smoke: FAIL (sanitized report could not be written safely)");
    }
    console.log(`Admin navigation smoke: ${status} (executed=${counts.PASS + counts.FAIL}, passed=${counts.PASS}, failed=${counts.FAIL})`);
    console.log(`Artifact: ${reportPath}`);
    console.log(`Cleanup: chrome=${chromeCleaned ? "PASS" : "FAIL"}, apiServer=${apiCleaned ? "PASS" : "FAIL"}, webServer=${webCleaned ? "PASS" : "FAIL"}, tempData=${workDirCleaned ? "PASS" : "FAIL"}`);
    process.exitCode = exitCode;
  }
}

void main();
