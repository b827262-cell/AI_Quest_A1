import { expect, it } from "vitest";
import { GUEST_ASK_SYSTEM_PROMPT } from "../src/prompts/guest-ask.prompt";

it("uses the iBrain AI brand in the guest tutor prompt", () => {
  expect(GUEST_ASK_SYSTEM_PROMPT).toContain("你是 iBrain AI 的學習助教");
  expect(GUEST_ASK_SYSTEM_PROMPT).not.toContain("AI-SmartBook");
});
