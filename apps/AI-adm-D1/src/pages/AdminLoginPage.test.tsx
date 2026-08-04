// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuthProvider, getAdminToken } from "../adminAuth";
import { AdminLoginPage } from "./AdminLoginPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderLogin(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/admin/login"]}>
        <AdminAuthProvider>
          <AdminLoginPage />
        </AdminAuthProvider>
      </MemoryRouter>
    );
  });
  return { root, container };
}

function enterValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

describe("AdminLoginPage", () => {
  const mounted: Root[] = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("stores the verified token after a successful login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const rendered = await renderLogin();
    mounted.push(rendered.root);

    const input = rendered.container.querySelector<HTMLInputElement>("#admin-password");
    const form = rendered.container.querySelector<HTMLFormElement>("form");
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();

    await act(async () => {
      if (input) {
        enterValue(input, "verified-token");
      }
    });
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getAdminToken()).toBe("verified-token");
  });

  it("does not store a rejected token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const rendered = await renderLogin();
    mounted.push(rendered.root);

    const input = rendered.container.querySelector<HTMLInputElement>("#admin-password");
    const form = rendered.container.querySelector<HTMLFormElement>("form");

    await act(async () => {
      if (input) {
        enterValue(input, "wrong-token");
      }
    });
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getAdminToken()).toBeNull();
    expect(rendered.container.textContent).toContain("管理員憑證無效或已過期");
  });
});
