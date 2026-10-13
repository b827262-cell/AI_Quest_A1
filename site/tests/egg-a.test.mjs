import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BRAND_MARK_ACTIVATION_WINDOW_MS, recordBrandMarkActivation } from "../app/page.tsx";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("Egg A only completes three consecutive BrandMark activations within 2000ms", () => {
  const first = recordBrandMarkActivation([], 1_000);
  const second = recordBrandMarkActivation(first, 1_800);
  assert.equal(recordBrandMarkActivation(second, 2_999).length, 3);
  assert.equal(recordBrandMarkActivation(second, 3_801).length, 1);
  assert.equal(BRAND_MARK_ACTIVATION_WINDOW_MS, 2_000);
});

test("Egg A is an inline accessible non-navigating status badge with all dismiss paths", () => {
  assert.match(page, /<button className="v2-brand-trigger" type="button" aria-label="啟用 BrandMark Sparkle Quest Badge" onClick=\{activateBrandMark\}>/);
  assert.match(page, /<a className="v2-brand-home" href="#top" aria-label="AI-SmartBook 首頁"><strong>AI-SmartBook<\/strong><\/a>/, "the pre-Egg brand/home navigation remains available");
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(page, /✦ AI Quest A-01: Web AI Ready ✦/);
  assert.match(page, /aria-label="關閉 BrandMark Sparkle Quest Badge"/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /if \(showBrandMarkBadge\)/, "an activation after display dismisses it");
  assert.match(page, /brandMarkActivations\.current = \[\];\n\s*setShowBrandMarkBadge\(false\);/, "Escape and dismiss reset the activation sequence");
  assert.doesNotMatch(page, /localStorage|sessionStorage|document\.cookie/);
  assert.match(css, /\.v2-brand-trigger\{display:grid;width:44px;height:44px;/, "BrandMark trigger meets the 44px mobile minimum");
  assert.match(css, /\.v2-brand-badge button\{display:grid;width:44px;height:44px;flex:0 0 44px;/, "BrandMark dismiss target meets the 44px mobile minimum");
  assert.match(css, /\.v2-brand-badge\{position:absolute;z-index:3;top:calc\(100% \+ 5px\);left:0;/, "the badge is anchored out of flow beneath the title without shifting header or hero");
  assert.match(css, /prefers-reduced-motion:reduce/, "motion preference is respected");
});
