import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL(".", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, root), "utf8");
// AiProvidersPage 已拆成 pages/ai-providers/ 子模組，因此原始碼掃描需同時涵蓋原檔與新目錄全部檔案。
const readAiProvidersSources = () => [
  read("pages/AiProvidersPage.tsx"),
  ...readdirSync(new URL("pages/ai-providers/", root)).sort().map((file) => read(`pages/ai-providers/${file}`))
].join("\n");

describe("Admin browser/server boundary", () => {
  it("keeps the Admin client entry free of Node-only modules and secrets", () => {
    const clientSources = [
      read("main.tsx"),
      read("App.tsx"),
      read("api.ts"),
      readAiProvidersSources(),
      read("pages/AiAnalyticsPage.tsx")
    ].join("\n");
    expect(clientSources).not.toMatch(/node:(?:crypto|fs|path|os)/);
    expect(clientSources).not.toMatch(/AI_CREDENTIAL_ENCRYPTION_KEY|IP_HASH_SECRET|GUEST_ASK_IP_HMAC_SECRET/);
    expect(clientSources).not.toContain("@ai-smartbook/ai/server");
    expect(clientSources).not.toContain("@ai-smartbook/db");
  });

  it("uses the explicit browser-safe AI entry for pricing", () => {
    expect(readAiProvidersSources()).toContain("@ai-smartbook/ai/browser");
    expect(read("../../../packages/ai/src/browser.ts")).not.toMatch(/node:crypto|createHmac|process\.env/);
    expect(read("../../../packages/ai/src/index.ts")).not.toContain("gateway/ip-hash");
    expect(read("../../../packages/ai/src/index.ts")).not.toContain("gateway/recovery-token");
  });

  it("keeps the Node HMAC helper in the server entry", () => {
    expect(read("../../../packages/ai/src/server/ip-hash.ts")).toContain('from "node:crypto"');
    expect(read("../../../packages/ai/src/server.ts")).toContain("./server/ip-hash");
  });
});
