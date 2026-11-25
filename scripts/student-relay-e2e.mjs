// e2e:student-relay — REAL Playwright Chromium E2E for the R16 Google AI relay
// simulator (Windows side-by-side popup + modal, intake channels A–D).
//
// Scope (R18-T4):
//   - Serves the built Student SPA locally from apps/AI-Stu-R1/dist.
//   - Intercepts every www.google.com popup request with a deterministic local
//     mock page (route.fulfill — no real network, same process).
//   - Blocks (abort) every other external request; app-origin requests flow to
//     the local static server; unspecified /api/** endpoints get a JSON stub.
//   - Drives cases E1–E7 against observable UI behavior and the persisted
//     learning-history localStorage records. An assertion that did not run is
//     never reported as PASS; the process exits 0 only when every executed
//     assertion passed in every case.
//
// Usage: node scripts/student-relay-e2e.mjs
// No package installs, no browser installs, no external sites, no secrets.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { artifactPath, releaseMetadata, sanitizeDiagnostic, writeSanitizedArtifact } from "./release-artifacts.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const distDir = join(repoRoot, "apps", "AI-Stu-R1", "dist");
const reportPath = artifactPath("student-relay-e2e", "E2E_REPORT_PATH");
const runTimeoutMs = Math.max(60_000, Math.min(900_000, Number(process.env.E2E_RELAY_TIMEOUT_MS || 420_000)));
const TOTAL_REQUIRED_CASES = 7;

const QUESTION = "什麼是光合作用？";
const ANSWER = "光合作用分成光反應與碳反應，在葉綠體中把光能轉成化學能。";
const SECOND_ANSWER = "雪山隧道全長十二點九公里，是台灣最長的公路隧道。";
const OLD_CLIPBOARD_TEXT = "上一次關閉視窗前殘留的舊剪貼簿文字。";
const OTHER_QUESTION = "一題完全不同的化學計算怎麼解？";
const OTHER_URL = `https://www.google.com/search?udm=50&q=${encodeURIComponent(OTHER_QUESTION)}`;
const SAME_URL = `https://www.google.com/search?udm=50&q=${encodeURIComponent(QUESTION)}`;
const NON_GOOGLE_URL = "https://example.com/not-google";
const HOSTILE_HTML = `<div><img src="x" onerror="window.__relay_pwned = true"><script>window.__relay_pwned = true;</script><p>${ANSWER}</p><a href="${SAME_URL}">來源</a></div>`;
const HISTORY_KEY = "ai-smartbook.student.learning-history.v1";

function findChromiumExecutable() {
  const override = process.env.STUDENT_SMOKE_CHROMIUM?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`STUDENT_SMOKE_CHROMIUM points to a missing file: ${override}`);
    return override;
  }
  const playwrightCache = join(homedir(), ".cache/ms-playwright");
  if (existsSync(playwrightCache)) {
    const entries = readdirSync(playwrightCache).sort().reverse();
    for (const entry of entries) {
      if (entry.startsWith("chromium-")) {
        const candidate = join(playwrightCache, entry, "chrome-linux64/chrome");
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const entry of entries) {
      if (entry.startsWith("chromium_headless_shell-")) {
        const candidate = join(playwrightCache, entry, "chrome-headless-shell-linux64/chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error("Chromium executable not found under ~/.cache/ms-playwright; refusing to install.");
}

function newestMtimeMs(dir) {
  let latest = 0;
  if (!existsSync(dir)) return latest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newestMtimeMs(full));
    else if (entry.isFile()) latest = Math.max(latest, statSync(full).mtimeMs);
  }
  return latest;
}

// Build only if the bundle is missing or older than src (same policy as
// student:web-e2e; never installs anything).
function ensureStudentBundle() {
  const distEntry = join(distDir, "index.html");
  if (existsSync(distEntry) && statSync(distEntry).mtimeMs >= newestMtimeMs(join(repoRoot, "apps/AI-Stu-R1/src"))) return "current";
  const build = spawnSync("corepack", ["pnpm@9.15.0", "--filter", "AI-Stu-R1", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (build.status !== 0 || !existsSync(distEntry)) throw new Error("student bundle build failed");
  return "rebuilt";
}

// Minimal local static server with SPA fallback. Listens on loopback only.
function startStaticServer() {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json"
  };
  const server = createServer((request, response) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      let filePath = resolve(distDir, `.${urlPath}`);
      if (!filePath.startsWith(distDir)) filePath = join(distDir, "index.html");
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        // SPA fallback: BrowserRouter routes resolve to index.html.
        if (!extname(urlPath)) filePath = join(distDir, "index.html");
      }
      if (!existsSync(filePath)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      const body = readFileSync(filePath);
      response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("server error");
    }
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => resolveServer({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Deterministic local mock for the Google AI Mode popup (fulfilled, no network).
const GOOGLE_MOCK_HTML = `<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8"><title>Google AI 模擬（本機 mock）</title>
</head>
<body>
  <h1>Google AI 模擬頁（本機 mock）</h1>
  <p id="mock-question">題目：什麼是光合作用？</p>
  <div id="mock-answer">
    <p>光合作用分成光反應與碳反應，在葉綠體中把光能轉成化學能。植物利用葉綠素吸收陽光，把二氧化碳與水轉換成葡萄糖並釋出氧氣。</p>
    <a id="mock-source" href="https://www.google.com/search?udm=50&q=%E4%BB%80%E9%BA%BC%E6%98%AF%E5%85%89%E5%90%88%E4%BD%9C%E7%94%A8%EF%BC%9F">來源連結</a>
  </div>
  <script>window.__mockGoogleAi = true;</script>
</body>
</html>`;

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(address && typeof address !== "string" ? address.port : null));
    });
  });
}

function historyDigest(page) {
  // Persisted learning history as observable evidence (never bare secrets).
  return page.evaluate((key) => {
    try {
      const entries = JSON.parse(localStorage.getItem(key) || "[]");
      return entries.map((entry) => ({
        id: typeof entry.id === "string" ? entry.id.slice(0, 8) : null,
        question: entry.question,
        strategy: entry.strategy,
        rawAnswer: typeof entry.rawAnswer === "string" ? entry.rawAnswer.trim() || null : null,
        organizedAnswer: typeof entry.organizedAnswer === "string" ? entry.organizedAnswer.trim() || null : null,
        sourceUrl: entry.sourceUrl ?? null
      }));
    } catch {
      return [];
    }
  }, HISTORY_KEY);
}

// Dispatchers MUST be real function objects: page.evaluate(string) evaluates an
// arrow as a mere expression and never invokes it (verified: "() => 42" -> undefined).
const PASTE_DISPATCHER = ([plain, html]) => {
  const data = new DataTransfer();
  data.setData("text/plain", plain);
  data.setData("text/html", html);
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  (document.querySelector(".google-relay-panel") || document.body).dispatchEvent(event);
};
const DROP_DISPATCHER = ([plain, html]) => {
  const target = document.querySelector(".google-relay-modal");
  if (!target) return false;
  const data = new DataTransfer();
  data.setData("text/plain", plain);
  if (html) data.setData("text/html", html);
  const drop = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
  Object.defineProperty(drop, "preventDefault", { value: () => {} });
  target.dispatchEvent(drop);
  return true;
};
const FOCUS_DISPATCHER = () => {
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  return { visibility: document.visibilityState };
};

function makeSummary(entries) {
  const relevant = entries.filter((entry) => entry.strategy === "google-ai");
  const latest = relevant[0] ?? null;
  return {
    googleEntryCount: relevant.length,
    latest: latest && {
      question: latest.question,
      rawAnswer: latest.rawAnswer,
      organizedAnswer: latest.organizedAnswer,
      sourceUrl: latest.sourceUrl
    }
  };
}

// ---------------------------------------------------------------------------
// Case runner
// ---------------------------------------------------------------------------

class CaseResult {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.status = "PASS";
    this.detail = "";
    this.startedAt = Date.now();
    this.assertions = [];
  }

  check(name, condition, evidence = null) {
    const state = condition ? "PASS" : "FAIL";
    this.assertions.push({ name, state, ...(evidence !== null ? { evidence: sanitizeDiagnostic(JSON.stringify(evidence), 300) } : {}) });
    if (!condition) throw new Error(`assertion failed: ${name}`);
  }

  finish(error, statusOverride = null) {
    this.durationMs = Date.now() - this.startedAt;
    if (error) {
      const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 500);
      this.detail = this.status === "BLOCKED" ? this.detail || message : message;
      if (statusOverride) this.status = statusOverride;
      else if (this.status !== "BLOCKED") this.status = "FAIL";
    }
    // Assertions that never executed get an explicit BLOCKED state — never PASS.
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      durationMs: this.durationMs,
      detail: this.detail,
      assertionCount: this.assertions.length,
      assertionsPassed: this.assertions.filter((item) => item.state === "PASS").length,
      assertions: this.assertions
    };
  }
}

async function openGuestPage(context, { withClipboardPermissions = true } = {}) {
  if (withClipboardPermissions) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(context.__baseUrl).origin });
  }
  const page = await context.newPage();
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.goto(`${context.__baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator('select[aria-label="解答方式"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('select[aria-label="解答方式"]').selectOption("google-ai");
  const strategy = await page.locator('select[aria-label="解答方式"]').inputValue();
  if (strategy !== "google-ai") throw new Error(`strategy is not google-ai: ${strategy}`);
  return { page, dialogs };
}

async function askQuestion(page, question = QUESTION) {
  await page.locator('textarea[aria-label="訪客問題"]').fill(question);
  await page.locator('button[aria-label="送出問題"]').click();
  // The desktop relay opens the named Google popup and mounts the modal.
  await page.locator(".google-relay-modal").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400); // let the modal-open clipboard snapshot land
}

async function popupUrlOf(context) {
  const mockPages = context.pages().filter((page) => new URL(page.url()).hostname === "www.google.com");
  return mockPages;
}

// Shared route plan: external blocker first-registered (falls back on
// same-origin), then api/site-config/guest-quota stubs, then the newest
// www.google.com mock (Playwright checks newest handlers first).
function installCaseRoutes(context, baseUrl, onExternalBlock = () => {}) {
  return Promise.all([
    context.route("**/*", (route) => {
      const href = route.request().url();
      if (!href.startsWith(baseUrl)) {
        onExternalBlock(href);
        void route.abort("blockedbyclient");
        return;
      }
      void route.fallback();
    }),
    context.route("**/api/**", (route) => void route.fulfill({ status: 200, contentType: "application/json", body: "{}" })),
    context.route("**/api/public/site-config", (route) => void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        siteTitle: "iBrain AI", siteSubtitle: "多模型領域智慧解題平台", homeGreeting: "今天想學習什麼？",
        homeInputPlaceholder: "輸入你的問題……", guestAiEnabled: true, guestDailyLimit: 3,
        studentLoginEnabled: true, maintenanceNotice: ""
      })
    })),
    context.route("**/api/public/guest-quota", (route) => void route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ guestAiEnabled: true, dailyLimit: 3, usedCount: 0, remainingCount: 3, blocked: false })
    })),
    context.route((url) => url.hostname === "www.google.com", (route) =>
      void route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: GOOGLE_MOCK_HTML }))
  ]);
}

async function runCase(caseResult, browser, baseUrl, caseSetup) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  context.__baseUrl = baseUrl;
  let externalBlockedCount = 0;
  const externalBlockSamples = [];
  await installCaseRoutes(context, baseUrl, (href) => {
    externalBlockedCount += 1;
    if (externalBlockSamples.length < 5) externalBlockSamples.push(href);
  });

  try {
    await caseSetup(caseResult, context);
  } catch (setupError) {
    throw setupError;
  } finally {
    context.__network = { externalBlockedCount, externalBlockSamples };
  }
  return { externalBlockedCount, externalBlockSamples };
}

// ---------------------------------------------------------------------------
// Cases E1–E7
// ---------------------------------------------------------------------------

async function caseE1(caseResult, context) {
  const { page } = await openGuestPage(context);
  const popupPromise = context.waitForEvent("page", { timeout: 10_000 });
  await askQuestion(page);
  const popup = await popupPromise;
  caseResult.check("E1: desktop submit opens the named Google popup", new URL(popup.url()).hostname === "www.google.com" && popup.url().includes("udm=50"), { popupUrl: popup.url() });
  caseResult.check("E1: relay modal is mounted with the locked question", (await page.locator(".google-relay-modal").textContent())?.includes(QUESTION) === true);

  await page.evaluate(PASTE_DISPATCHER, [`${ANSWER}\n${SAME_URL}`, `<div><p>${ANSWER}</p><a href="${SAME_URL}">來源</a></div>`]);
  await page.locator(".google-relay-status", { hasText: "已收到回答" }).waitFor({ state: "visible", timeout: 10_000 });

  const summary = makeSummary(await historyDigest(page));
  caseResult.check("E1: raw answer persisted", summary.latest?.rawAnswer === ANSWER, summary.latest);
  caseResult.check("E1: organized answer derived and persisted", typeof summary.latest?.organizedAnswer === "string" && summary.latest.organizedAnswer.includes("光反應"), summary.latest);
  caseResult.check("E1: Google udm=50 source URL persisted", typeof summary.latest?.sourceUrl === "string" && summary.latest.sourceUrl.includes("udm=50"), summary.latest);
  caseResult.check("E1: received UI confirmation shown", (await page.locator(".google-relay-status").textContent())?.includes("已收到回答") === true);
  caseResult.check("E1: completed state exposes finish action", (await page.locator(".google-relay-modal").textContent())?.includes("完成並關閉") === true);

  const htmlRender = await popup.evaluate(() => window.__mockGoogleAi === true);
  caseResult.check("E1: popup content is the local deterministic mock", htmlRender === true);
}

async function caseE2(caseResult, context) {
  const { page } = await openGuestPage(context);
  await askQuestion(page);
  caseResult.check("E2: modal open before clipboard write", (await page.locator(".google-relay-modal").count()) === 1);
  const before = makeSummary(await historyDigest(page));
  caseResult.check("E2: nothing persisted before auto import", before.latest?.rawAnswer == null, before.latest);

  await page.evaluate((text) => navigator.clipboard.writeText(text), SECOND_ANSWER);
  await page.evaluate(FOCUS_DISPATCHER);
  await page.locator(".google-relay-status", { hasText: "已收到回答" }).waitFor({ state: "visible", timeout: 10_000 });

  const after = makeSummary(await historyDigest(page));
  caseResult.check("E2: fresh clipboard answer auto-imported without keystrokes", after.latest?.rawAnswer === SECOND_ANSWER, after.latest);
  caseResult.check("E2: imported answer persisted to learning history", after.googleEntryCount >= 1);
  const keystrokes = await page.evaluate(() => ({ focusedElement: document.activeElement?.tagName ?? null }));
  caseResult.check("E2: import happened with no paste/drop gesture", keystrokes.focusedElement !== "TEXTAREA" && after.latest?.rawAnswer === SECOND_ANSWER, keystrokes);
}

async function caseE3(caseResult, context) {
  // Fresh context WITHOUT the clipboard-read grant.
  const { page, dialogs } = await openGuestPage(context, { withClipboardPermissions: false });
  await askQuestion(page);
  caseResult.check("E3: modal visible before focus test", (await page.locator(".google-relay-modal").count()) === 1);
  const before = makeSummary(await historyDigest(page));
  caseResult.check("E3: nothing persisted before focus", before.latest?.rawAnswer == null, before.latest);

  await page.evaluate(FOCUS_DISPATCHER);
  await page.evaluate(FOCUS_DISPATCHER); // repeat: denied reads must never surface
  await page.waitForTimeout(600);
  const after = makeSummary(await historyDigest(page));
  caseResult.check("E3: denied clipboard read imports nothing", after.latest?.rawAnswer == null, after.latest);
  caseResult.check("E3: no blocking dialog raised", dialogs.length === 0, dialogs);
  caseResult.check("E3: no blocking error message surfaced", !(await page.locator(".google-relay-modal").textContent())?.includes("無法讀取剪貼簿"));
  caseResult.check("E3: modal remains mounted and usable", (await page.locator(".google-relay-modal").count()) === 1);

  await page.evaluate(PASTE_DISPATCHER, [`${ANSWER}\n${SAME_URL}`, `<div><p>${ANSWER}</p><a href="${SAME_URL}">來源</a></div>`]);
  await page.locator(".google-relay-status", { hasText: "已收到回答" }).waitFor({ state: "visible", timeout: 10_000 });
  const recovered = makeSummary(await historyDigest(page));
  caseResult.check("E3: paste path still succeeds after silent degrade", recovered.latest?.rawAnswer === ANSWER, recovered.latest);
}

async function caseE4(caseResult, context) {
  const { page } = await openGuestPage(context);
  await askQuestion(page);
  const before = makeSummary(await historyDigest(page));
  caseResult.check("E4: nothing persisted before drop", before.latest?.rawAnswer == null, before.latest);

  const dropped = await page.evaluate(DROP_DISPATCHER, [ANSWER, `<div><p>${ANSWER}</p><a href="${SAME_URL}">來源</a></div>`]);
  caseResult.check("E4: drop target present and event dispatched", dropped === true);
  await page.locator(".google-relay-status", { hasText: "已收到回答" }).waitFor({ state: "visible", timeout: 10_000 });
  const after = makeSummary(await historyDigest(page));
  caseResult.check("E4: dropped answer persisted", after.latest?.rawAnswer === ANSWER, after.latest);
  caseResult.check("E4: drop payload source URL persisted", typeof after.latest?.sourceUrl === "string" && after.latest.sourceUrl.includes("udm=50"), after.latest);
}

async function caseE5(caseResult, context) {
  // 5a: pre-seeded old clipboard text (learner has NOT copied a new answer).
  {
    const { page } = await openGuestPage(context);
    await page.evaluate((text) => navigator.clipboard.writeText(text), OLD_CLIPBOARD_TEXT);
    await askQuestion(page);
    const snapshotCheck = await page.evaluate(() => ({ relayOpen: Boolean(document.querySelector(".google-relay-modal")) }));
    caseResult.check("E5a: relay modal open with pre-seeded clipboard", snapshotCheck.relayOpen === true, snapshotCheck);
    await page.evaluate(FOCUS_DISPATCHER);
    await page.evaluate(FOCUS_DISPATCHER);
    await page.waitForTimeout(600);
    const summary = makeSummary(await historyDigest(page));
    caseResult.check("E5a: unchanged old clipboard silently ignored on focus", summary.latest?.rawAnswer == null, summary.latest);
    caseResult.check("E5a: no misleading success status shown", !(await page.locator(".google-relay-modal").textContent())?.includes("已收到回答"));
  }
  // 5b: clipboard holding the current question text (fresh context, isolated storage).
  {
    const contextB = context.browser().newContext
      ? await context.browser().newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
      : null;
    if (!contextB) throw new Error("could not create isolated context for E5b");
    contextB.__baseUrl = context.__baseUrl;
    // Same route plan as every other context so even E5b's popup request is
    // client-blocked/mocked and never reaches the real network.
    await installCaseRoutes(contextB, context.__baseUrl);
    try {
      const { page } = await openGuestPage(contextB);
      await page.evaluate((text) => navigator.clipboard.writeText(text), QUESTION);
      await askQuestion(page);
      await page.evaluate(FOCUS_DISPATCHER);
      await page.evaluate(FOCUS_DISPATCHER);
      await page.waitForTimeout(600);
      const summary = makeSummary(await historyDigest(page));
      const summaryMain = makeSummary(await historyDigest(page));
      caseResult.check("E5b: clipboard equal to the current question silently ignored", summaryMain.latest?.rawAnswer == null && summary.latest?.rawAnswer == null, summaryMain.latest);
      caseResult.check("E5b: no success status shown", !(await page.locator(".google-relay-modal").textContent())?.includes("已收到回答"));
    } finally {
      await contextB.close();
    }
  }
}

async function caseE6(caseResult, context) {
  const { page } = await openGuestPage(context);
  await askQuestion(page);

  await page.evaluate(PASTE_DISPATCHER, [OTHER_URL, ""]);
  await page.locator(".google-relay-status", { hasText: "保護規則" }).waitFor({ state: "visible", timeout: 10_000 });
  let summary = makeSummary(await historyDigest(page));
  caseResult.check("E6: other-question udm=50 URL triggers protection and is not imported", summary.latest?.rawAnswer == null && summary.latest?.sourceUrl == null, summary.latest);
  caseResult.check("E6: conflict state is visible on the modal", (await page.locator(".google-relay-modal").getAttribute("data-conflict")) === "true");

  await page.evaluate(PASTE_DISPATCHER, [NON_GOOGLE_URL, ""]);
  await page.locator(".google-relay-status", { hasText: "不是 Google AI Mode 連結" }).waitFor({ state: "visible", timeout: 10_000 });
  summary = makeSummary(await historyDigest(page));
  caseResult.check("E6: non-Google URL is rejected without persistence", summary.latest?.rawAnswer == null && summary.latest?.sourceUrl == null, summary.latest);
}

async function caseE6b(caseResult, context) {
  const { page } = await openGuestPage(context);
  await askQuestion(page);
  caseResult.check("E6b: relay modal mounted for hostile payload", (await page.locator(".google-relay-modal").count()) === 1);
  await page.evaluate(PASTE_DISPATCHER, ["prose-with-hostile-html", HOSTILE_HTML]);
  await page.waitForTimeout(600);
  const pwned = await page.evaluate(() => window.__relay_pwned);
  const summary = makeSummary(await historyDigest(page));
  caseResult.check("E6b: hostile script/onerror never executes", pwned === undefined, { __relay_pwned: pwned });
  caseResult.check("E6b: safe answer text from hostile html persisted as prose", summary.latest?.rawAnswer === ANSWER, summary.latest);
  caseResult.check("E6b: source URL extracted from hostile html is the validated udm=50 link", typeof summary.latest?.sourceUrl === "string" && summary.latest.sourceUrl.includes("udm=50"), summary.latest);
}

async function caseE7(caseResult, context) {
  const { page } = await openGuestPage(context);
  const popupPromise = context.waitForEvent("page", { timeout: 10_000 });
  await askQuestion(page);
  const popup = await popupPromise;
  caseResult.check("E7: first submit opens exactly one mocked popup", (await popupUrlOf(context)).length === 1, { url: popup.url() });

  // Step 1: same-question URL only.
  await page.evaluate(PASTE_DISPATCHER, [SAME_URL, ""]);
  await page.locator(".google-relay-status", { hasText: "第 1 步完成" }).waitFor({ state: "visible", timeout: 10_000 });
  let summary = makeSummary(await historyDigest(page));
  caseResult.check("E7: step 1 binds only the source URL", typeof summary.latest?.sourceUrl === "string" && summary.latest.sourceUrl.includes("udm=50") && summary.latest.rawAnswer == null, summary.latest);

  // Step 2: the answer prose completes the relay.
  await page.evaluate(PASTE_DISPATCHER, [ANSWER, `<div><p>${ANSWER}</p><a href="${SAME_URL}">來源</a></div>`]);
  await page.locator(".google-relay-status", { hasText: "已收到回答" }).waitFor({ state: "visible", timeout: 10_000 });
  summary = makeSummary(await historyDigest(page));
  caseResult.check("E7: step 2 persists the raw answer", summary.latest?.rawAnswer === ANSWER, summary.latest);
  caseResult.check("E7: imported state exposes finish action", (await page.locator(".google-relay-modal").textContent())?.includes("完成並關閉") === true);

  // Popup reuse: reopening the relay must target the SAME fixed window name —
  // the browser-level "one named relay window" contract. Headless Chromium via
  // CDP does not coalesce named windows (each window.open spawns a page even
  // with an identical name), so reuse intent is verified by spying window.open
  // instead of counting pages.
  await page.evaluate(() => {
    window.__relayOpens = [];
    window.open = (href, name, features) => {
      window.__relayOpens.push({ url: String(href ?? ""), name: String(name ?? "") });
      return null;
    };
  });
  await page.locator(".google-relay-reopen").click();
  await page.waitForTimeout(400);
  const opens = await page.evaluate(() => window.__relayOpens);
  caseResult.check(
    "E7: reopen targets the fixed relay window name without a second popup intent (headless CDP does not coalesce named windows)",
    opens.length === 1 && opens[0].name === "ai_smartbook_google_relay" && opens[0].url.includes("udm=50"),
    { opens }
  );
  await page.locator(".google-relay-close").click();
  caseResult.check("E7: modal closes cleanly after completion", (await page.locator(".google-relay-modal").count()) === 0);
}

// ---------------------------------------------------------------------------

async function main() {
  let staticServer = null;
  let browser = null;
  let chromiumPath = null;
  const startedAt = new Date().toISOString();
  const runStart = Date.now();
  const casos = [];
  let externalBlockSamples = [];
  let externalBlockedTotal = 0;

  try {
    chromiumPath = findChromiumExecutable();
    const bundleState = ensureStudentBundle();
    if (bundleState !== "current") console.log("student bundle rebuilt");

    const started = await startStaticServer();
    staticServer = started.server;
    const baseUrl = started.baseUrl;

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--disable-dev-shm-usage"]
    });

    const caseDefs = [
      ["E1", "paste text/plain + text/html Google udm=50 payload; raw/organized answer, source URL and received UI", caseE1],
      ["E2", "clipboard permission granted: fresh answer + focus auto-import without keystrokes", caseE2],
      ["E3", "no clipboard-read grant: silent degrade, no import, no dialog; paste path still works", caseE3],
      ["E4", "drop event on the real drop target persists the answer", caseE4],
      ["E5", "pre-seeded old clipboard and current-question text are silently ignored on focus", caseE5],
      ["E6", "other-question udm=50 conflict, non-Google URL, hostile HTML never persist or execute", caseE6, caseE6b],
      ["E7", "URL-first two-step binding/import + same-name popup reuse", caseE7]
    ];

    for (const [id, title, ...handlers] of caseDefs) {
      // E6 runs two sub-scenarios; merge their results into one case record.
      const merged = new CaseResult(id, title);
      const subResults = [];
      for (const handler of handlers) {
        const sub = new CaseResult(`${id}#sub${subResults.length + 1}`, title);
        try {
          const scenario = await runCase(sub, browser, baseUrl, handler);
          subResults.push(sub.finish(null, "PASS"));
          externalBlockedTotal += scenario.externalBlockedCount;
          externalBlockSamples.push(...scenario.externalBlockSamples);
        } catch (error) {
          const blocked = /Chromium executable not found|browser unavailable|browser launch/i.test(error?.message || "");
          subResults.push(sub.finish(error, blocked ? "BLOCKED" : null));
        }
      }
      merged.status = subResults.every((sub) => sub.status === "PASS")
        ? "PASS"
        : subResults.some((sub) => sub.status === "BLOCKED") ? "BLOCKED" : "FAIL";
      merged.assertions = subResults.flatMap((sub) => sub.assertions);
      merged.durationMs = subResults.reduce((total, sub) => total + sub.durationMs, 0);
      merged.assertionsPassed = merged.assertions.filter((item) => item.state === "PASS").length;
      merged.detail = subResults.filter((sub) => sub.detail).map((sub) => `${sub.id}: ${sub.detail}`).join("; ");
      casos.push(merged);
    }

    if (browser) await browser.close();
    browser = null;
  } catch (error) {
    // Bootstrap failure: report every case as BLOCKED, never PASS.
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 800);
    const present = new Set(casos.map((item) => item.id));
    for (let index = 1; index <= TOTAL_REQUIRED_CASES; index += 1) {
      const id = `E${index}`;
      if (present.has(id)) continue;
      const missing = new CaseResult(id, "blocked before execution — never reported as PASS");
      casos.push(missing.finish(new Error(message), "BLOCKED"));
    }
    return finishRun({ startedAt, runStart, casos, chromiumPath, staticServer, externalBlockSamples, externalBlockedTotal, bootstrapError: message });
  }
  return finishRun({ startedAt, runStart, casos, chromiumPath, staticServer, externalBlockSamples, externalBlockedTotal, bootstrapError: null });
}

function finishRun({ startedAt, runStart, casos, chromiumPath, staticServer, externalBlockSamples, externalBlockedTotal, bootstrapError }) {
  try {
    staticServer?.close();
  } catch { /* already closed */ }

  const caseRecords = casos.map((item) => item);
  const assertions = caseRecords.flatMap((record) => record.assertions);
  const counts = {
    executed: assertions.filter((item) => item.state !== "BLOCKED").length,
    passed: assertions.filter((item) => item.state === "PASS").length,
    failed: assertions.filter((item) => item.state === "FAIL").length,
    blocked: assertions.filter((item) => item.state === "BLOCKED").length
  };
  const status = bootstrapError
    ? "BLOCKED"
    : caseRecords.every((record) => record.status === "PASS") && counts.failed === 0 && counts.executed > 0
      ? "PASS"
      : caseRecords.some((record) => record.status === "BLOCKED") ? "BLOCKED" : "FAIL";
  const exitCode = status === "PASS" ? 0 : status === "BLOCKED" ? 2 : 1;

  const artifact = writeSanitizedArtifact(reportPath, {
    ...releaseMetadata(process.env.RELEASE_ENVIRONMENT || "local"),
    status,
    exitCode,
    runner: "playwright-core + Chromium (ms-playwright cache)",
    executable: chromiumPath ? chromiumPath.split("/").slice(-3).join("/") : null,
    cases: caseRecords,
    assertionCounts: counts,
    network: {
      policy: "google-mocked;external-blocked",
      googleMock: "route.fulfill from scripts/student-relay-e2e.mjs (local, deterministic, no external site contacted)",
      externalBlockedCount: externalBlockedTotal,
      externalBlockSamples: externalBlockSamples.slice(0, 8),
      appOrigin: "local static server (127.0.0.1 loopback only)"
    },
    bootstrapError
  });

  console.log(`student-relay-e2e: ${status} (cases=${caseRecords.filter((record) => record.status === "PASS").length}/${TOTAL_REQUIRED_CASES} PASS, assertions=${counts.passed}/${counts.executed} passed, failed=${counts.failed}, blocked=${counts.blocked})`);
  for (const record of caseRecords) {
    console.log(`  ${record.id}: ${record.status} — ${record.title} (${record.durationMs} ms, assertions ${record.assertionsPassed}/${record.assertionCount})${record.detail ? ` :: ${record.detail}` : ""}`);
  }
  console.log(`Artifact: ${reportPath} (written=${artifact.written})`);
  if (!artifact.written) {
    console.error("student-relay-e2e: FAIL (artifact could not be written)");
    process.exitCode = 1;
    return 1;
  }
  process.exitCode = exitCode;
  return exitCode;
}

void main();
