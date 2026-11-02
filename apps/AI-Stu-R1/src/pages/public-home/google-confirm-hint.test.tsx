// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicHero } from "./PublicHero";
import { DEFAULT_CONFIG, GOOGLE_CONFIRM_HINT } from "./constants";
import { useGuestQuestion } from "./useGuestQuestion";

vi.mock("../../components/HomeAIComposer", () => ({ HomeAIComposer: () => null }));
vi.mock("./LearningHistoryPanel", () => ({ LearningHistoryPanel: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => { root?.render(<MemoryRouter>{node}</MemoryRouter>); });
}

describe("Google confirmation hint", () => {
  it.each([["google-ai", true], ["api", false]])("shows the pre-submit hint only for %s", async (strategy, visible) => {
    const guest = { strategy, response: null, restoringAnswer: false, category: "auto", busy: false };
    const history = { studentName: "", authStatus: "anonymous", learningHistory: [] };
    const intake = { googleStatus: "", pendingIntake: null, historyStatuses: {} };
    await render(<PublicHero config={DEFAULT_CONFIG} guest={guest as never} history={history as never} intake={intake as never} />);
    expect(container?.textContent?.includes(GOOGLE_CONFIRM_HINT)).toBe(visible);
  });

  it("includes the hint in the status after sending the full question to Google", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    function Harness() {
      const [status, setStatus] = useState("");
      const guest = useGuestQuestion({ config: DEFAULT_CONFIG, setLearningHistory: () => undefined, setGoogleStatus: setStatus });
      return <><button onClick={() => guest.setQuestion("完整題目？")}>輸入</button><button onClick={() => guest.submitGoogleAiQuestion("manual")}>送出</button><p role="status">{status}</p></>;
    }
    await render(<Harness />);
    const buttons = container!.querySelectorAll("button");
    await act(async () => { buttons[0].click(); });
    await act(async () => { buttons[1].click(); });
    expect(container?.querySelector('[role="status"]')?.textContent).toContain(GOOGLE_CONFIRM_HINT);
    expect(open).toHaveBeenCalledOnce();
    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("完整題目？");
    expect(url.searchParams.get("udm")).toBe("50");
  });
});
