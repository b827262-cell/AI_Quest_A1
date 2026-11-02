// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../api-transport", () => ({ http: request }));
import { StudentPasscodesPage } from "./StudentPasscodesPage";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.clearAllMocks(); });
function click(text: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`missing button ${text}`);
  button.click();
}
it("requires confirmation before resetting and does not send a request on cancel", async () => {
  request.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST"
    ? { passcode: "ABCDE-FGHJK" }
    : { passcodes: [{ id: "id1", email: "user@example.test", status: "active", note: null }] });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<StudentPasscodesPage />); });
  expect(container.querySelector(".admin-table-wrap table")).not.toBeNull();
  await act(async () => { click("重設", container); });
  let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("所有已登入的裝置都將登出");
  await act(async () => { click("取消", dialog); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { click("重設", container); });
  dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () => { click("確定", dialog); });
  expect(request).toHaveBeenCalledWith("/api/admin/student-passcodes/id1/reset", expect.objectContaining({ method: "POST" }));
});
