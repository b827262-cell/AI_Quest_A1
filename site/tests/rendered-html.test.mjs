import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the AI-SmartBook learning homepage", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /AI-SmartBook/);
  assert.match(html, /把閱讀、提問與/);
  assert.match(html, /智慧書庫/);
  assert.match(html, /閱讀輔助/);
  assert.match(html, /學習進度/);
  assert.match(html, /管理工作台/);
  assert.match(html, /Chrome Built-in AI/);
  assert.match(html, /id="auto-answer"/);
  assert.match(html, /auto-question/);
  assert.match(html, /送出問題/);
  assert.match(html, /快速題型/);
  assert.match(html, /class="v2-hero-art v2-reveal v2-delay-1" role="img" aria-label="AI-SmartBook 學習介面示意"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /\/signin-with-chatgpt/);
  assert.match(html, /\/admin/);
  assert.doesNotMatch(html, /\/login\b/);
  assert.doesNotMatch(html, /\/guest-answer\b/);
  assert.doesNotMatch(html, /\/admin\/login\b/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview|react-loading-skeleton/);
});

// H3 accessibility remediation: normal text must clear WCAG 2.1 AA (>=4.5:1)
// against the background it actually renders on. The stylesheet keeps the
// original foreground tokens and corrects them with a later rule, so the
// effective color is the last winning declaration for each selector.
const wcagCases = [
  { selector: ".v2-note", background: "#f9fbff", label: "hero note" },
  { selector: ".v2-trust", background: "#f9fbff", label: "trust bar" },
  { selector: ".v2-eyebrow", background: "#f9fbff", label: "eyebrow on page" },
  { selector: ".v2-eyebrow", background: "#edf3ff", label: "eyebrow on workflow band" },
  { selector: ".v2-feature-card p", background: "#ffffff", label: "feature card copy" },
  { selector: ".v2-feature-card>span", background: "#ffffff", label: "feature card number" },
  { selector: ".v2-architecture small", background: "#ffffff", label: "architecture card label" },
  { selector: ".v2-architecture article>span", background: "#f2f5ff", label: "backend architecture service label" },
  { selector: ".v2-steps li>span", background: "#edf3ff", label: "workflow step number" },
  { selector: ".v2-steps p", background: "#edf3ff", label: "workflow copy" },
  { selector: ".v2-architecture p", background: "#ffffff", label: "architecture card copy" },
  { selector: ".v2-architecture p", background: "#f2f5ff", label: "backend architecture card copy" },
  { selector: ".v2-nav nav a:hover,.v2-nav-login:hover", background: "#f9fbff", label: "navigation hover text" },
  { selector: ".v2-button-primary", background: "#4569e0", label: "primary CTA text at gradient start" },
  { selector: ".v2-architecture small", background: "#f2f5ff", label: "backend architecture card label" },
];

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    let v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function effectiveColor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  let winner = null;
  for (const block of blocks) {
    const color = /(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{6})/.exec(block[1]);
    if (color) winner = color[1];
  }
  assert.ok(winner, `no color declaration found for ${selector}`);
  return winner;
}

test("homepage normal text meets WCAG AA contrast against its rendered background", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const { selector, background, label } of wcagCases) {
    const color = effectiveColor(css, selector);
    const ratio = contrastRatio(color, background);
    assert.ok(ratio >= 4.5, `${label}: ${selector} ${color} vs ${background} = ${ratio.toFixed(2)}:1 (<4.5:1 AA)`);
  }
});
