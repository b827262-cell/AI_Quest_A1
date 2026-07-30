import { describe, expect, it } from "vitest";
import { ApiHttpError } from "./api";
import { providerErrorMessage } from "./providerErrorMessage";

describe("Provider API error messages", () => {
  it("maps safe backend error codes without exposing internals", () => {
    expect(providerErrorMessage(new ApiHttpError(409, "顯示名稱已存在", "provider_identity_conflict")))
      .toBe("Provider 顯示名稱或 Slug 已存在，請使用不同值。");
    expect(providerErrorMessage(new ApiHttpError(422, "ignored", "validation_error", { baseUrl: "invalid" })))
      .toContain("Base URL");
    expect(providerErrorMessage(new ApiHttpError(500, "ignored", "unexpected_error")))
      .toBe("Provider 操作失敗，請稍後再試。");
    expect(providerErrorMessage(new ApiHttpError(409, "SQLITE UNIQUE constraint failed", "provider_already_exists")))
      .not.toContain("SQLITE");
  });
});
