// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAdminAuthHeaders,
  clearAdminToken,
  getAdminToken,
  isAdminApiRequest,
  setAdminToken
} from "./adminAuth";

describe("admin browser authentication", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("stores the token only for the current browser session and clears it on logout", () => {
    setAdminToken("  test-admin-token  ");
    expect(getAdminToken()).toBe("test-admin-token");

    clearAdminToken();
    expect(getAdminToken()).toBeNull();
  });

  it("adds the admin token without overwriting an explicit authorization header", () => {
    setAdminToken("test-admin-token");
    expect(buildAdminAuthHeaders().get("x-admin-token")).toBe("test-admin-token");

    const explicit = buildAdminAuthHeaders({ Authorization: "Bearer explicit-token" });
    expect(explicit.get("authorization")).toBe("Bearer explicit-token");
    expect(explicit.has("x-admin-token")).toBe(false);
  });

  it("only classifies same-origin admin API requests as protected", () => {
    expect(isAdminApiRequest("/api/admin/books")).toBe(true);
    expect(isAdminApiRequest("/api/books")).toBe(false);
    expect(isAdminApiRequest("https://example.com/api/admin/books")).toBe(false);
  });
});
