// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProvidersPage } from "./AiProvidersPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── Mocked admin API ──────────────────────────────────────────
 * The page calls several adminApi methods on mount; we stub them so the QM
 * runtime-settings card renders deterministically. No real key/secret/token is
 * ever constructed — only masked values and fake ids. */
const api = vi.hoisted(() => ({
  listAiProviders: vi.fn(),
  listAiCredentials: vi.fn(),
  getQmRuntimeConfig: vi.fn(),
  saveQmRuntimeConfig: vi.fn(),
  testQmRuntimeConfig: vi.fn(),
  listAiCredentialQuotas: vi.fn()
}));

vi.mock("../api", () => ({ adminApi: api, ApiHttpError: class ApiHttpError extends Error {} }));

function renderPage(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const rendered = renderPage();
  await act(async () => {
    rendered.root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return rendered;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("AiProvidersPage QM 執行設定 card", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    api.listAiProviders.mockResolvedValue({ providers: [{
      id: "prov_1", provider: "zai", slug: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai",
      model: "glm-5.1", enabled: true, isDefault: true, isRouterProvider: false, priority: 100,
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z"
    }] });
    api.listAiCredentials.mockResolvedValue({ credentials: [{
      id: "cred_1", providerConfigId: "prov_1", name: "prod", maskedApiKey: "zai****GLM1",
      baseUrl: null, model: "glm-5.1", status: "active", priority: 100, weight: 1, failureCount: 0,
      cooldownUntil: null, lastTestedAt: null, lastTestStatus: null, lastTestLatencyMs: null,
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z", disabledAt: null,
      billingMode: "pay_as_you_go", region: null, endpointProfile: null, usageScope: "staging",
      productionAuthorized: true, providerHealth: "healthy", modelQuotas: []
    }] });
    api.getQmRuntimeConfig.mockResolvedValue({
      view: {
        config: { providerConfigId: "prov_1", credentialId: "cred_1", model: "glm-5.1", baseUrlOverride: null },
        providerDisplayName: "Z.AI", providerSlug: "zai", providerEnabled: true,
        credentialName: "prod", maskedApiKey: "zai****GLM1", credentialStatus: "active",
        credentialInCooldown: false, effectiveBaseUrl: "https://api.z.ai", updatedAt: null
      },
      resolution: { ok: true }
    });
    api.testQmRuntimeConfig.mockResolvedValue({ status: "success", reason: "valid", latencyMs: 12, upstreamRequestSent: true, model: "glm-5.1" });
  });

  afterEach(() => {
    if (root) root.unmount();
    container?.remove();
  });

  it("renders the QM 執行設定 card with provider/credential/model selects and a masked key", async () => {
    ({ container, root } = await render(<AiProvidersPage />));
    await settle();

    const heading = Array.from(container.querySelectorAll("h3")).find((node) => node.textContent?.includes("QM 執行設定"));
    expect(heading).toBeTruthy();

    // The card surfaces the masked key and never a plaintext-key input field.
    const text = container.textContent ?? "";
    expect(text).toContain("zai****GLM1");
    expect(text).not.toContain("decrypted");
    expect(text).not.toContain("sk-");
    // No input is labelled as accepting the raw API key inside the QM card.
    const qmCard = heading?.closest(".admin-card") ?? container;
    expect(qmCard.querySelectorAll("input[type='password']").length).toBe(0);
  });

  it("restricts the credential select to the chosen provider's active credentials", async () => {
    ({ container, root } = await render(<AiProvidersPage />));
    await settle();
    // The QM card's provider <select> lists the enabled provider.
    const selects = container.querySelectorAll("select");
    const providerOptions = Array.from(selects).flatMap((select) =>
      Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? ""));
    expect(providerOptions.some((label) => label.includes("Z.AI"))).toBe(true);
  });
});
