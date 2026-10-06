import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");

describe("Search Friend PWA contract", () => {
  it("declares owned PNG icons and a multipart POST share target without a provider key", () => {
    const manifest = JSON.parse(readFileSync(resolve(appRoot, "public/manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    expect(manifest.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icons/ai-smartbook-192.png", sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ src: "/icons/ai-smartbook-512.png", sizes: "512x512", type: "image/png" })
    ]));
    for (const [file, size] of [["ai-smartbook-192.png", 192], ["ai-smartbook-512.png", 512]] as const) {
      const png = readFileSync(resolve(appRoot, "public/icons", file));
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    const worker = readFileSync(resolve(appRoot, "public/sw.js"), "utf8");
    expect(worker).toContain('request.method === "POST"');
    expect(worker).toContain('url.pathname === "/share-target"');
    expect(worker).toContain("request.formData()");
    expect(worker).toContain('new Request("/"');
  });

  it("serves PWA files directly and routes the share intake to the SPA", () => {
    const nginx = readFileSync(resolve(repositoryRoot, "deploy/nginx/ai-stu-r1.conf"), "utf8");
    expect(nginx).toContain("location = /manifest.webmanifest");
    expect(nginx).toContain("location = /sw.js");
    expect(nginx).toContain("location = /share-target { try_files $uri /index.html; }");
  });

  it("keeps the clipboard fallback behind its explicit button gesture", () => {
    const css = readFileSync(resolve(appRoot, "src/styles.css"), "utf8");
    const page = readFileSync(resolve(appRoot, "src/pages/PublicHomePage.tsx"), "utf8");
    expect(css).toContain("@media (max-width: 412px)"); // Covers 360, 390, and 412 CSS-pixel viewports.
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".learning-history-raw-evidence pre");
    expect(page).toContain("查看原始回覆");
    expect(page).toContain('role="alert" aria-live="assertive"');
    expect(page).toContain("pendingIntakeHeadingRef.current?.focus()");
    expect(page).not.toContain('params.get("url")');
    expect(page.match(/navigator\.clipboard\?\.readText/g)).toHaveLength(1); // no automatic clipboard read on load
    expect(page).toContain('onClick={() => void pasteGoogleAnswer(entry)}');
    expect(page).toContain('從剪貼簿帶回回答');
    expect(page).toContain('手動貼上備援');
    expect(page).toContain('extractSharedAnswerText(rawAnswer, sharedUrl)');
  });
});
