import { afterEach, describe, expect, it, vi } from "vitest";
import { studentClient } from "./studentClient";

afterEach(() => vi.unstubAllGlobals());
describe("guest quota responses", () => {
  it.each(["limit_reached", "rate_limited"] as const)("retains %s response counts", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status, remainingGuestQuestions: 0 }), { status: 429 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).resolves.toMatchObject({ status, remainingGuestQuestions: 0 });
  });
  it("keeps a positive remaining count during cooldown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "rate_limited", remainingGuestQuestions: 2, retryAfterSeconds: 12 }), { status: 429 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).resolves.toMatchObject({ status: "rate_limited", remainingGuestQuestions: 2, retryAfterSeconds: 12 });
  });
  it("throws for an unrecognized 429 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "other", message: "拒絕" }), { status: 429 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).rejects.toThrow("拒絕");
  });
  it("returns the capacity busy response without a remaining count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "busy", message: "訪客服務目前繁忙，請稍後再試或登入使用" }), { status: 503 })));
    const response = await studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" });
    expect(response).toMatchObject({ status: "busy" });
    expect(response.remainingGuestQuestions).toBeUndefined();
  });
  it("continues to reject unrelated failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "服務失敗" }), { status: 503 })));
    await expect(studentClient.askAsGuest({ question: "題目", category: "auto", sourceType: "manual" })).rejects.toThrow("服務失敗");
  });
});
