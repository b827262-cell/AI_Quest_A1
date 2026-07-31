import { describe, expect, it } from "vitest";
import { ApiHttpError } from "./api";
import { credentialErrorMessage, credentialFieldErrors, credentialFormAfterFailure } from "./credentialErrorMessage";

describe("Credential API error messages", () => {
  it("maps validation field errors without using the server message", () => {
    const error = new ApiHttpError(422, "SQL or provider detail", "validation_error", {
      name: "名稱為必填",
      baseUrl: "格式錯誤"
    });
    expect(credentialErrorMessage(error, "save")).toContain("名稱");
    expect(credentialErrorMessage(error, "save")).toContain("Credential Base URL");
    expect(credentialErrorMessage(error, "save")).not.toContain("SQL");
    expect(credentialFieldErrors(error)).toEqual({ name: "名稱為必填", baseUrl: "格式錯誤" });
  });

  it("labels endpointProfile validation errors instead of leaking the raw field key", () => {
    const error = new ApiHttpError(422, "ignored", "validation_error", {
      endpointProfile: "欄位格式不正確"
    });
    expect(credentialErrorMessage(error, "save")).toContain("Endpoint Profile");
    expect(credentialErrorMessage(error, "save")).not.toContain("API Key");
  });

  it("maps safe backend classifications", () => {
    expect(credentialErrorMessage(new ApiHttpError(404, "ignored", "provider_not_found"), "save"))
      .toContain("Provider");
    expect(credentialErrorMessage(new ApiHttpError(409, "UNIQUE constraint", "credential_already_exists"), "save"))
      .toContain("已存在");
    expect(credentialErrorMessage(new ApiHttpError(503, "vault secret", "credential_vault_unavailable"), "save"))
      .not.toContain("vault secret");
    expect(credentialErrorMessage(new ApiHttpError(500, "stack trace", "credential_storage_failed"), "save"))
      .not.toContain("stack trace");
  });

  it("renders safe Credential Test diagnostics without raw provider details", () => {
    const error = new ApiHttpError(
      401,
      "ignored upstream body",
      undefined,
      undefined,
      {
        reason: "invalid_api_key",
        latencyMs: 382,
        endpointProfile: "gemini_native",
        upstreamRequestSent: true
      }
    );
    const message = credentialErrorMessage(error, "test");
    expect(message).toContain("Provider 拒絕此 API Key");
    expect(message).toContain("382 ms");
    expect(message).toContain("Gemini Native API");
    expect(message).toContain("已送出");
    expect(message).not.toContain("upstream body");
  });

  it("clears only the write-only API key after a failed create", () => {
    const form = { name: "primary", apiKey: "secret-is-not-printed", model: "gemini-3.5-flash", priority: 100, weight: 1 };
    expect(credentialFormAfterFailure(form, true)).toEqual({
      ...form,
      apiKey: ""
    });
    expect(credentialFormAfterFailure(form, true).name).toBe("primary");
    expect(credentialFormAfterFailure(form, true).model).toBe("gemini-3.5-flash");
    expect(credentialFormAfterFailure(form, true).priority).toBe(100);
  });
});
