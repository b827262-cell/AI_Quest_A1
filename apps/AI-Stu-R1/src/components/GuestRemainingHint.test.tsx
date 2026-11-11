import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { GuestRemainingHint } from "./GuestRemainingHint";
import { GuestAnswer } from "../pages/public-home/GuestAnswer";

describe("guest remaining hint", () => {
  it.each([0, 2])("shows the returned count %i with its scope", (remaining) => {
    const markup = renderToStaticMarkup(<MemoryRouter><GuestAnswer question="問題" response={{ requestId: "guest", status: "success", remainingGuestQuestions: remaining }} onFeedback={() => {}} onReset={() => {}} onRetry={() => {}} /></MemoryRouter>);
    expect(markup).toContain(`訪客剩餘次數：${remaining}`);
    expect(markup).toContain("此為本裝置／目前網路的訪客剩餘次數，不是個人帳號額度");
  });
  it("does not invent a count when the API has not returned one", () => {
    const markup = renderToStaticMarkup(<GuestRemainingHint />);
    expect(markup).toContain("尚無資料（送出訪客問題後更新）");
  });
});
