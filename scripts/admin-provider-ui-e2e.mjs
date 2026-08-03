import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  artifactPath,
  releaseMetadata,
  sanitizeDiagnostic,
  writeSanitizedArtifact
} from "./release-artifacts.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const distDir = join(root, "apps", "AI-adm-D1", "dist");
const configuredChrome = process.env.E2E_CHROME_EXECUTABLE?.trim() || process.env.CHROME_BIN?.trim();
const chromeCandidates = (configuredChrome ? [configuredChrome] : ["google-chrome", "chromium", "/snap/bin/chromium"]).filter(Boolean);
const e2eTimeoutMs = Math.max(5_000, Math.min(180_000, Number(process.env.E2E_TIMEOUT_MS || 30_000)));
const reportPath = artifactPath("admin-provider-e2e", "E2E_REPORT_PATH");
const screenshotPath = process.env.E2E_SCREENSHOT_PATH?.trim()
  ? resolve(process.env.E2E_SCREENSHOT_PATH.trim())
  : join(root, "release-artifacts", "phase3a", "admin-provider-e2e.png");
const allowNoSandbox = /^(?:1|true|yes)$/i.test(process.env.E2E_CHROME_NO_SANDBOX || "");
const TOTAL_ASSERTIONS = 24;
const testKey = ["fixture", "credential", "only"].join("-");
const sensitiveResponseTokens = [testKey, "encryptedApiKey", "authorization", "Bearer "];

const MOCK_SOURCE = String.raw`
(() => {
  // window.name survives location.reload(), but this harness stores only
  // non-sensitive boolean test controls. It is never read by production code.
  const runnerStatePrefix = "__aiSmartBookPhase3aE2e:";
  const readRunnerState = () => {
    try {
      if (!window.name.startsWith(runnerStatePrefix)) return {};
      const value = JSON.parse(window.name.slice(runnerStatePrefix.length));
      return value && typeof value === "object" ? value : {};
    } catch { return {}; }
  };
  const runnerState = readRunnerState();
  const persistRunnerState = () => {
    window.name = runnerStatePrefix + JSON.stringify({
      authenticated: Boolean(state.authenticated),
      failProviderList: Boolean(state.failProviderList),
      failNextTest: Boolean(state.failNextTest),
      delayMs: Number(state.delayMs) || 0
    });
  };
  const state = {
    authenticated: Boolean(runnerState.authenticated),
    failProviderList: Boolean(runnerState.failProviderList),
    failNextTest: Boolean(runnerState.failNextTest),
    delayMs: Number(runnerState.delayMs) || 80,
    providerUpdateCount: 0,
    providerCreatePayload: null,
    providerUpdatePayload: null,
    credentialCreateHadKey: false,
    credentialUpdateHadKey: false,
    credentialUpdatePayload: null,
    networkResponseSecretDetected: false,
    providers: [{
      id: "provider-1", provider: "openai", displayName: "OpenAI",
      baseUrl: null, model: "fixture-model", enabled: true,
      isDefault: true, isRouterProvider: true, priority: 10,
      createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z"
    }],
    credentials: {
      "provider-1": [{
        id: "credential-1", providerConfigId: "provider-1", name: "Seed Credential",
        maskedApiKey: "fixture-****BEEF", baseUrl: null, model: null,
        status: "active", priority: 10, weight: 1, failureCount: 0,
        cooldownUntil: null, lastTestedAt: null, lastTestStatus: null,
        lastTestLatencyMs: null, createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z", disabledAt: null
      }]
    }
  };

  const forbiddenResponseTokens = [${JSON.stringify(testKey)}, "encryptedApiKey", "Authorization", "Bearer "];
  const json = (value, status = 200) => {
    const serialized = JSON.stringify(value);
    if (forbiddenResponseTokens.some((token) => serialized.includes(token))) state.networkResponseSecretDetected = true;
    return new Response(serialized, { status, headers: { "Content-Type": "application/json" } });
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const responseProvider = (provider) => copy(provider);
  const responseCredential = (credential) => copy(credential);

  window.__phase3aE2e = {
    state,
    setAuthenticated(value) { state.authenticated = Boolean(value); persistRunnerState(); },
    setFailProviderList(value) { state.failProviderList = Boolean(value); persistRunnerState(); },
    setFailNextTest(value) { state.failNextTest = Boolean(value); persistRunnerState(); },
    setDelay(value) { state.delayMs = Number(value) || 0; persistRunnerState(); },
    snapshot() { return copy({
      providerUpdateCount: state.providerUpdateCount,
      providerCreatePayload: state.providerCreatePayload,
      providerUpdatePayload: state.providerUpdatePayload,
      credentialCreateHadKey: state.credentialCreateHadKey,
      credentialUpdateHadKey: state.credentialUpdateHadKey,
      credentialUpdatePayload: state.credentialUpdatePayload,
      networkResponseSecretDetected: state.networkResponseSecretDetected
    }); }
  };
  persistRunnerState();

  window.confirm = () => true;
  window.fetch = async (input, init = {}) => {
    if (state.delayMs > 0) await wait(state.delayMs);
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = (init.method || "GET").toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body || "{}") : {};
    const adminPath = path.startsWith("/api/admin/");
    if (adminPath && !state.authenticated) return json({ error: "admin authentication required" }, 401);
    if (path === "/api/appearance-settings") return json({ settings: {} });
    if (path === "/api/admin/ai-providers" && method === "GET") {
      if (state.failProviderList) return json({ error: "internal server error" }, 500);
      return json({ providers: state.providers.map(responseProvider) });
    }
    if (path === "/api/admin/ai-providers" && method === "POST") {
      state.providerCreatePayload = copy(body);
      const provider = { ...body, id: "provider-2", baseUrl: body.baseUrl ?? null, model: body.model ?? null,
        createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" };
      state.providers.push(provider);
      state.credentials[provider.id] = [];
      return json({ provider: responseProvider(provider) }, 201);
    }
    if (path === "/api/admin/ai-providers" && method === "PUT") {
      const provider = state.providers.find((row) => row.id === body.id);
      if (!provider) return json({ error: "not found" }, 404);
      Object.assign(provider, body, { updatedAt: "2026-07-23T00:00:00.000Z" });
      state.providerUpdateCount += 1;
      state.providerUpdatePayload = copy(body);
      return json({ provider: responseProvider(provider) });
    }
    const credentialList = path.match(/^\/api\/admin\/ai-providers\/([^/]+)\/credentials$/);
    if (credentialList && method === "GET") return json({ credentials: (state.credentials[credentialList[1]] ?? []).map(responseCredential) });
    if (credentialList && method === "POST") {
      state.credentialCreateHadKey = typeof body.apiKey === "string" && body.apiKey.length > 0;
      const credential = { ...body, id: "credential-2", providerConfigId: credentialList[1],
        maskedApiKey: "fixture-****C0DE", apiKey: undefined, baseUrl: body.baseUrl ?? null,
        model: body.model ?? null, failureCount: 0, cooldownUntil: null,
        lastTestedAt: null, lastTestStatus: null, lastTestLatencyMs: null,
        createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z", disabledAt: null };
      delete credential.apiKey;
      state.credentials[credentialList[1]] ??= [];
      state.credentials[credentialList[1]].push(credential);
      return json({ credential: responseCredential(credential) }, 201);
    }
    const credentialMatch = path.match(/^\/api\/admin\/ai-credentials\/([^/]+)(?:\/(test|enable|disable))?$/);
    if (credentialMatch) {
      const id = credentialMatch[1];
      const action = credentialMatch[2];
      const row = Object.values(state.credentials).flat().find((credential) => credential.id === id);
      if (!row) return json({ error: "not found" }, 404);
      if (method === "PUT" && !action) {
        state.credentialUpdateHadKey = typeof body.apiKey === "string" && body.apiKey.length > 0;
        state.credentialUpdatePayload = copy(body);
        Object.assign(row, body, { updatedAt: "2026-07-23T00:00:00.000Z" });
        delete row.apiKey;
        return json({ credential: responseCredential(row) });
      }
      if (method === "POST" && action === "test") {
        if (state.failNextTest) {
          state.failNextTest = false;
          persistRunnerState();
          row.failureCount += 1;
          row.cooldownUntil = "2026-07-23T00:05:00.000Z";
          return json({ error: "provider request failed" }, 503);
        }
        row.lastTestStatus = "success";
        row.lastTestedAt = "2026-07-23T00:00:01.000Z";
        row.lastTestLatencyMs = 12;
        return json({ status: "success", latencyMs: 12 });
      }
      if (method === "POST" && (action === "enable" || action === "disable")) {
        row.status = action === "enable" ? "active" : "disabled";
        row.disabledAt = action === "disable" ? "2026-07-23T00:00:02.000Z" : null;
        return json({ credential: responseCredential(row) });
      }
      if (method === "DELETE" && !action) {
        for (const list of Object.values(state.credentials)) {
          const index = list.findIndex((credential) => credential.id === id);
          if (index >= 0) list.splice(index, 1);
        }
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: "mock endpoint not implemented" }, 404);
  };

  try { history.replaceState({}, "", "/admin/ai-providers"); } catch { /* file URL history can reject in some browsers */ }
})();
`;

function fail(message) {
  throw new Error(message);
}

function cdpClient(url) {
  return new Promise((resolveClient, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    socket.addEventListener("open", () => resolveClient({
      socket,
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
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket unavailable")));
  });
}

async function waitFor(cdp, expression, timeoutMs = 10000) {
  const started = Date.now();
  const boundedTimeout = Math.min(timeoutMs, e2eTimeoutMs);
  while (Date.now() - started < boundedTimeout) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.value) return result.result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`browser condition timed out: ${expression.slice(0, 100)}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.text || "browser evaluation failed");
  return result.result?.value;
}

function escapeString(value) {
  return JSON.stringify(value);
}

async function clickButton(cdp, label, rowText = null) {
  const expression = `(function () {
    const buttons = [...document.querySelectorAll("button")];
    const button = buttons.find((item) => item.textContent.includes(${escapeString(label)}) &&
      (!${escapeString(rowText)} || item.closest("tr")?.textContent.includes(${escapeString(rowText)})));
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if (!(await evaluate(cdp, expression))) fail(`button not found: ${label}`);
}

async function fillInput(cdp, label, value, occurrence = 0) {
  const expression = `(function () {
    const labels = [...document.querySelectorAll("label")];
    const label = labels.filter((item) => item.textContent.includes(${escapeString(label)}))[${Number(occurrence)}];
    const input = label?.querySelector("input, select, textarea");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
    setter?.call(input, ${escapeString(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
  if (!(await evaluate(cdp, expression))) fail(`form control not found: ${label}`);
}

async function bodyText(cdp) {
  return String(await evaluate(cdp, "document.body.innerText"));
}

class BrowserLaunchError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = "BrowserLaunchError";
    this.diagnostics = diagnostics;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  const stopped = await new Promise((resolveStopped) => {
    const timer = setTimeout(() => resolveStopped(false), 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStopped(true);
    });
  });
  if (!stopped && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return stopped;
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
    const executable = candidate;
    const child = spawn(executable, launchArgs, { stdio: ["ignore", "ignore", "pipe"] });
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
          executable: basename(executable),
          exit: `${code ?? "null"}/${signal ?? "none"}`,
          error: spawnError || undefined,
          stderr: sanitizeDiagnostic(stderr)
        });
      });
    });
    if (endpoint) return { child, endpoint, usedNoSandbox: allowNoSandbox, diagnostics };
    await stopChild(child);
  }
  const last = diagnostics.at(-1);
  throw new BrowserLaunchError(
    `headless browser unavailable: ${last?.executable || "no candidate"} (${last?.exit || "not started"})`,
    diagnostics
  );
}

async function getPageTarget(endpoint) {
  const parsed = new URL(endpoint);
  const response = await fetch(`http://127.0.0.1:${parsed.port}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) fail("Chrome page target unavailable");
  return target.webSocketDebuggerUrl;
}

function navigationUrl(htmlPath) {
  const configured = process.env.E2E_ADMIN_BASE_URL?.trim() || process.env.E2E_BASE_URL?.trim();
  if (!configured) return `file://${htmlPath}`;
  const url = new URL(configured);
  if (!/^https?:$/.test(url.protocol)) throw new Error("E2E base URL must use HTTP(S)");
  return new URL("/admin/ai-providers", url).toString();
}

async function captureSafeScreenshot(cdp) {
  try {
    const result = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (!result.data) return null;
    mkdirSync(dirname(screenshotPath), { recursive: true, mode: 0o700 });
    writeFileSync(screenshotPath, Buffer.from(result.data, "base64"), { mode: 0o600 });
    return screenshotPath;
  } catch {
    return null;
  }
}

async function main() {
  let workDir;
  let browser;
  let cdp;
  let screenshot = null;
  let status = "PASS";
  let exitCode = 0;
  let failureReason;
  let networkResponseSecretScan = "NOT RUN";
  let browserConsoleSecretScan = "NOT RUN";
  const assertions = [];
  const consoleMessages = [];
  const check = (name, condition) => {
    const state = condition ? "PASS" : "FAIL";
    assertions.push({ name, state });
    if (!condition) throw new Error(`assertion failed: ${name}`);
  };

  try {
    if (!existsSync(join(distDir, "index.html"))) fail("admin build is missing; run pnpm --filter AI-adm-D1 build first");
    const asset = readdirSync(distDir + "/assets").find((name) => name.endsWith(".js"));
    if (!asset) fail("admin JavaScript asset is missing");
    workDir = mkdtempSync(join(tmpdir(), "ai-smartbook-ui-e2e-"));
    const profileDir = join(workDir, "chrome-profile");
    const htmlPath = join(workDir, "admin.html");
    const assetUrl = `file://${join(distDir, "assets", asset)}`;
    writeFileSync(htmlPath, `<!doctype html><html><body><div id="root"></div><script type="module" src="${assetUrl}"></script></body></html>`);

    browser = await launchChrome(profileDir);
    cdp = await cdpClient(await getPageTarget(browser.endpoint));
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");
    const version = await cdp.send("Browser.getVersion");
    browser.version = typeof version?.product === "string" ? version.product : "unknown";
    cdp.socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.method === "Runtime.consoleAPICalled" || message.method === "Log.entryAdded") {
          consoleMessages.push(JSON.stringify(message));
        }
      } catch { /* diagnostics only */ }
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK_SOURCE });
    await cdp.send("Page.navigate", { url: navigationUrl(htmlPath) });

    await waitFor(cdp, `document.body.innerText.includes("Provider 設定載入中") || document.body.innerText.includes("Provider 設定無法載入")`);
    const unauthenticatedText = await bodyText(cdp);
    check("provider loading state is shown", unauthenticatedText.includes("Provider 設定載入中"));
    await waitFor(cdp, `document.body.innerText.includes("Provider 設定無法載入")`);
    check("unauthenticated management API is rejected", (await bodyText(cdp)).includes("Provider 設定無法載入"));

    await evaluate(cdp, "window.__phase3aE2e.setAuthenticated(true); location.reload();");
    await waitFor(cdp, "document.readyState === 'complete' && Boolean(window.__phase3aE2e) && window.__phase3aE2e.state.authenticated === true");
    await waitFor(cdp, `document.body.innerText.includes("OpenAI")`);
    await evaluate(cdp, "window.__phase3aE2e.setDelay(0)");
    check("provider list loads", (await bodyText(cdp)).includes("Provider 清單"));

    await clickButton(cdp, "新增 Provider");
    await fillInput(cdp, "顯示名稱", "E2E Provider");
    await clickButton(cdp, "儲存 Provider");
    await waitFor(cdp, `document.body.innerText.includes("Provider 設定已儲存")`);
    const createdProvider = await evaluate(cdp, "window.__phase3aE2e.snapshot().providerCreatePayload");
    check("provider can be created", (await bodyText(cdp)).includes("E2E Provider") && createdProvider?.priority === 100);

    await clickButton(cdp, "編輯／管理 Key", "OpenAI");
    await waitFor(cdp, `document.body.innerText.includes("fixture-****BEEF")`);
    await fillInput(cdp, "顯示名稱", "OpenAI Edited");
    await fillInput(cdp, "Priority", "7");
    await clickButton(cdp, "儲存 Provider");
    await waitFor(cdp, `document.body.innerText.includes("Provider 設定已儲存")`);
    const updatedProvider = await evaluate(cdp, "window.__phase3aE2e.snapshot().providerUpdatePayload");
    check("provider can be edited", (await bodyText(cdp)).includes("OpenAI Edited") && updatedProvider?.priority === 7);

    await clickButton(cdp, "停用 Provider");
    await waitFor(cdp, `document.body.innerText.includes("Provider 已停用")`);
    check("provider can be disabled", true);
    await clickButton(cdp, "啟用 Provider");
    await waitFor(cdp, `document.body.innerText.includes("Provider 已啟用")`);
    check("provider can be enabled", true);

    await evaluate(cdp, "window.__phase3aE2e.setDelay(250)");
    await fillInput(cdp, "顯示名稱", "OpenAI Dedup");
    const beforeDuplicateSave = await evaluate(cdp, "window.__phase3aE2e.snapshot().providerUpdateCount");
    await clickButton(cdp, "儲存 Provider");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saveDisabled = await evaluate(cdp, `[...document.querySelectorAll("button")].some((button) => button.disabled && button.textContent.includes("處理中"))`);
    await evaluate(cdp, `(function () {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("處理中"));
      if (button && !button.disabled) button.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes("Provider 設定已儲存")`);
    await evaluate(cdp, "window.__phase3aE2e.setDelay(0)");
    const afterDuplicateSave = await evaluate(cdp, "window.__phase3aE2e.snapshot().providerUpdateCount");
    check("provider duplicate submission is disabled", saveDisabled && afterDuplicateSave === beforeDuplicateSave + 1);

    await fillInput(cdp, "名稱", "E2E Credential");
    await fillInput(cdp, "API Key", testKey);
    check("credential key field is password/write-only", Boolean(await evaluate(cdp, `document.querySelector('input[type="password"]')?.value === ${escapeString(testKey)}`)));
    await clickButton(cdp, "加密新增 Credential");
    await waitFor(cdp, `document.body.innerText.includes("fixture-****C0DE")`);
    check("credential is created with masked response", (await bodyText(cdp)).includes("fixture-****C0DE"));

    await clickButton(cdp, "編輯", "E2E Credential");
    check("editing credential leaves key blank", Boolean(await evaluate(cdp, `document.querySelector('input[type="password"]')?.value === ""`)));
    await clickButton(cdp, "新增模型配額");
    const quotaAddMode = await evaluate(cdp, `(() => {
      const defaultModelLabel = [...document.querySelectorAll("label")].find((item) => item.textContent.includes("設為預設模型"));
      return {
        editing: document.body.innerText.includes("預設模型與配額"),
        keyBlank: document.querySelector('input[type="password"]')?.value === "",
        newModelIsNotDefault: defaultModelLabel?.querySelector("input")?.checked === false
      };
    })()`);
    check("quota list add action enters new quota mode without changing credential key", quotaAddMode?.editing === true && quotaAddMode?.keyBlank === true && quotaAddMode?.newModelIsNotDefault === true);
    await clickButton(cdp, "取消編輯");
    await fillInput(cdp, "名稱", "E2E Credential Edited");
    await fillInput(cdp, "狀態", "standby");
    await fillInput(cdp, "Priority", "5", 1);
    await fillInput(cdp, "Weight", "3");
    await clickButton(cdp, "儲存 Credential");
    await waitFor(cdp, `document.body.innerText.includes("原 Key 保留")`);
    const updatedCredential = await evaluate(cdp, "window.__phase3aE2e.snapshot()");
    check("blank replacement preserves existing key and updates standby routing metadata", updatedCredential.credentialUpdateHadKey === false && updatedCredential.credentialUpdatePayload?.status === "standby" && updatedCredential.credentialUpdatePayload?.priority === 5 && updatedCredential.credentialUpdatePayload?.weight === 3 && (await bodyText(cdp)).includes("Standby"));

    await clickButton(cdp, "測試", "E2E Credential Edited");
    await waitFor(cdp, `document.body.innerText.includes("連線測試完成：成功")`);
    check("credential connection success is shown", true);
    await evaluate(cdp, "window.__phase3aE2e.setFailNextTest(true)");
    await clickButton(cdp, "測試", "E2E Credential Edited");
    await waitFor(cdp, `document.body.innerText.includes("連線測試失敗")`);
    check("credential connection failure is redacted", !(await bodyText(cdp)).includes("provider request failed"));
    check("failure count and cooldown are displayed", (await bodyText(cdp)).includes("1") && (await bodyText(cdp)).includes("至 "));

    await clickButton(cdp, "停用", "E2E Credential Edited");
    await waitFor(cdp, `document.body.innerText.includes("Credential 已停用")`);
    check("credential status can be disabled", true);
    await clickButton(cdp, "啟用", "E2E Credential Edited");
    await waitFor(cdp, `document.body.innerText.includes("Credential 已啟用")`);
    check("credential status can be enabled", true);

    await clickButton(cdp, "軟刪除", "E2E Credential Edited");
    await waitFor(cdp, `!document.body.innerText.includes("E2E Credential Edited")`);
    check("soft delete confirmation removes credential from list", (await bodyText(cdp)).includes("Credential 已軟刪除"));
    check("empty credential state is shown", (await bodyText(cdp)).includes("此 Provider 尚無 Credential"));

    const snapshot = await evaluate(cdp, "window.__phase3aE2e.snapshot()");
    networkResponseSecretScan = snapshot.networkResponseSecretDetected ? "FAIL" : "PASS";
    check("credential create request contained only the write-only key", snapshot.credentialCreateHadKey === true);
    browserConsoleSecretScan = consoleMessages.some((message) => sensitiveResponseTokens.some((token) => message.includes(token))) ? "FAIL" : "PASS";
    check("browser console contains no secret material", browserConsoleSecretScan === "PASS");
    const pageText = await bodyText(cdp);
    check("page does not render key material or provider error body", !sensitiveResponseTokens.some((token) => pageText.includes(token)));

    await evaluate(cdp, "window.__phase3aE2e.setFailProviderList(true); location.reload();");
    await waitFor(cdp, "document.readyState === 'complete' && Boolean(window.__phase3aE2e) && window.__phase3aE2e.state.failProviderList === true");
    await waitFor(cdp, `document.body.innerText.includes("Provider 設定無法載入")`);
    check("provider loading error state is shown", (await bodyText(cdp)).includes("無法讀取 Provider 設定"));
    screenshot = await captureSafeScreenshot(cdp);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown browser E2E error";
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
    // Clear the only reload-persistent harness value before terminating Chrome.
    if (cdp) {
      try { await evaluate(cdp, "window.name = ''; true"); } catch { /* page may already be unavailable */ }
    }
    cdp?.close();
    const chromeCleaned = await stopChild(browser?.child);
    let workDirCleaned = true;
    if (workDir) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { workDirCleaned = false; }
    }
    while (assertions.length < TOTAL_ASSERTIONS) {
      assertions.push({ name: `unexecuted assertion ${assertions.length + 1}`, state: "BLOCKED" });
    }
    const counts = assertions.reduce((result, assertion) => {
      result[assertion.state] += 1;
      return result;
    }, { PASS: 0, FAIL: 0, BLOCKED: 0 });
    const artifact = writeSanitizedArtifact(reportPath, {
      ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "local"),
      status,
      target: process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL ? "configured admin base" : "local admin build",
      assertions,
      assertionCounts: {
        executed: counts.PASS + counts.FAIL,
        passed: counts.PASS,
        failed: counts.FAIL,
        blocked: counts.BLOCKED
      },
      browser: {
        executable: configuredChrome ? basename(configuredChrome) : "auto-detected",
        version: browser?.version || "unknown",
        noSandbox: allowNoSandbox,
        securityException: allowNoSandbox ? "E2E_CHROME_NO_SANDBOX=true; isolated CI/container policy is required" : null,
        diagnostics: browser?.diagnostics || []
      },
      browserConsoleSecretScan,
      networkResponseSecretScan,
      screenshotPath: screenshot,
      cleanup: {
        chromeProcess: chromeCleaned ? "PASS" : "FAIL",
        temporaryProfile: workDirCleaned ? "PASS" : "FAIL",
        // The harness loads a temporary file fixture and starts no HTTP mock server.
        testServer: "PASS"
      },
      blockedReason: failureReason
    });
    if (!artifact.written) {
      status = "FAIL";
      exitCode = 1;
      console.error("Browser UI E2E: FAIL (sanitized report could not be written safely)");
    }
    console.log(`Browser UI E2E: ${status} (executed=${counts.PASS + counts.FAIL}, passed=${counts.PASS}, failed=${counts.FAIL}, blocked=${counts.BLOCKED})`);
    console.log(`Artifact: ${reportPath}`);
    console.log(`Cleanup: chrome=${chromeCleaned ? "PASS" : "FAIL"}, temporaryProfile=${workDirCleaned ? "PASS" : "FAIL"}, testServer=PASS (not started)`);
    process.exitCode = exitCode;
  }
  return exitCode;
}

void main();
