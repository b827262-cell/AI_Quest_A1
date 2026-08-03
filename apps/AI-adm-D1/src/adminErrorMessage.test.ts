import { describe, expect, it } from "vitest";
import { ApiHttpError } from "./api";
import { categorizeAdminError, formatAdminErrorMessage } from "./adminErrorMessage";

describe("admin error categorization and formatting", () => {
  it("categorizes 401 as auth_required with a clear explanation", () => {
    const error = new ApiHttpError(401, "admin authentication required");
    const result = categorizeAdminError(error);
    expect(result.category).toBe("auth_required");
    expect(result.status).toBe(401);
    expect(result.message).toContain("401 Unauthorized");
    expect(result.message).toContain("ADMIN_API_TOKEN");
  });

  it("categorizes 403 as origin_forbidden with Tailscale/MagicDNS guidance", () => {
    const error = new ApiHttpError(403, "admin origin is not allowed");
    const result = categorizeAdminError(error);
    expect(result.category).toBe("origin_forbidden");
    expect(result.status).toBe(403);
    expect(result.message).toContain("403 Forbidden");
    expect(result.message).toContain("ADMIN_ALLOWED_ORIGINS");
    expect(result.message).toContain("Tailscale IP / MagicDNS");
  });

  it("categorizes 500/502/503 as server_error", () => {
    for (const status of [500, 502, 503]) {
      const error = new ApiHttpError(status, "Internal error");
      const result = categorizeAdminError(error);
      expect(result.category).toBe("server_error");
      expect(result.status).toBe(status);
      expect(result.message).toContain(`${status} Server Error`);
    }
  });

  it("categorizes TypeError / Failed to fetch as network_error", () => {
    const fetchError = new TypeError("Failed to fetch");
    const result = categorizeAdminError(fetchError);
    expect(result.category).toBe("network_error");
    expect(result.status).toBeNull();
    expect(result.message).toContain("Network Error");
    expect(result.message).toContain("網路連線失敗");
  });

  it("formats error messages distinctively for 401, 403, 5xx, and network errors", () => {
    const msg401 = formatAdminErrorMessage(new ApiHttpError(401, "auth error"));
    const msg403 = formatAdminErrorMessage(new ApiHttpError(403, "forbidden"));
    const msg500 = formatAdminErrorMessage(new ApiHttpError(500, "server crash"));
    const msgNet = formatAdminErrorMessage(new TypeError("Failed to fetch"));

    expect(msg401).toContain("401 Unauthorized");
    expect(msg403).toContain("403 Forbidden");
    expect(msg500).toContain("500 Server Error");
    expect(msgNet).toContain("Network Error");

    // All 4 messages must be distinct
    const uniqueMessages = new Set([msg401, msg403, msg500, msgNet]);
    expect(uniqueMessages.size).toBe(4);
  });

  it("secret leakage safeguard: categorized messages never leak actual token values", () => {
    const fakeToken = "super-secret-admin-token-12345";
    const errors = [
      new ApiHttpError(401, "admin authentication required"),
      new ApiHttpError(403, "admin origin is not allowed"),
      new ApiHttpError(500, `Error with token ${fakeToken}`),
      new TypeError("Failed to fetch")
    ];

    for (const err of errors) {
      const formatted = formatAdminErrorMessage(err);
      expect(formatted).not.toContain(fakeToken);
      expect(formatted).not.toContain("X-Admin-Token:");
    }
  });
});
