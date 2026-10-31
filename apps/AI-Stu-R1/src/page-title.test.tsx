// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StudentPageTitle } from "./page-title";
import { KnowledgeAiPage } from "./pages/KnowledgeAiPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("student brand and page title", () => {
  it.each([["/", "首頁"], ["/login", "登入"], ["/knowledge-ai", "知識達"], ["/books", "書櫃"], ["/dashboard", "儀表板"], ["/books/123", "閱讀器"]])("uses the branded title for %s", async (path, name) => {
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[path]}><StudentPageTitle />{path === "/knowledge-ai" && <KnowledgeAiPage />}</MemoryRouter>));
    expect(document.title).toBe(`${name} · iBrain AI`);
    if (path === "/knowledge-ai") expect(container.querySelector(".public-brand-link")?.textContent).toContain("iBrain AI");
    await act(async () => root.unmount());
    expect(document.title).toBe("iBrain AI");
    container.remove();
  });
});
