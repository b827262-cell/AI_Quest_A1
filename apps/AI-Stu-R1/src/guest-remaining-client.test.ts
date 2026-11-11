import { afterEach, describe, expect, it, vi } from "vitest";
import { studentClient } from "./studentClient";

afterEach(() => vi.unstubAllGlobals());
describe("guest quota responses", () => {
  it.each(["limit_reached", "rate_limited"] as const)("retains %s response counts", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status, remainingGuestQuestions: 0 }), { status: 429 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).resolves.toMatchObject({ status, remainingGuestQuestions: 0 });
  });
  it("continues to reject unrelated failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "服務失敗" }), { status: 503 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).rejects.toThrow("服務失敗");
  });
});
