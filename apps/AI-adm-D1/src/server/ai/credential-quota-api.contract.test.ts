import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("Credential model quota API contract", () => {
  it("validates create requests with the shared nullable quota schema", () => {
    const start = source.indexOf('app.post("/api/admin/ai-credentials/:credentialId/quotas"');
    const end = source.indexOf('app.put("/api/admin/ai-credential-quotas/:quotaId"', start);
    const route = source.slice(start, end);

    expect(route).toContain("createAiCredentialModelQuotaInputSchema.safeParse(req.body)");
    expect(route).toContain("repos.aiCredentialModelQuotas.create({ ...parsed.data, credentialId: credential.id })");
    expect(route).toContain("repos.aiCredentialModelQuotas.findForCredential(credential.id, parsed.data.model)");
    expect(route).toContain("同一 Credential 不可重複建立相同 Model 配額");
  });

  it("validates update requests with the shared nullable quota schema", () => {
    const start = source.indexOf('app.put("/api/admin/ai-credential-quotas/:quotaId"');
    const end = source.indexOf('app.post("/api/admin/ai-credential-quotas/:quotaId/default"', start);
    const route = source.slice(start, end);

    expect(route).toContain("updateAiCredentialModelQuotaInputSchema.safeParse(req.body)");
    expect(route).toContain("repos.aiCredentialModelQuotas.update(current.id, parsed.data)");
  });
});
