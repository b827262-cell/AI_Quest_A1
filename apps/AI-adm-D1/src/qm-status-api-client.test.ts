import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQmNotCheckedStatus } from "@ai-smartbook/contracts";
import { adminApi, ApiHttpError } from "./api";

describe("QM API client response boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses a shared not_checked response at the network boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makeQmNotCheckedStatus()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await adminApi.getQmStatus();
    expect(result.state).toBe("not_checked");
    expect(result.contract).toBeNull();
  });

  it("rejects malformed QM responses with a fixed client error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ overallStatus: "pass" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const error = await adminApi.getQmStatus().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).code).toBe("INVALID_API_RESPONSE");
    expect((error as ApiHttpError).message).toBe("Invalid response from server");
  });
});
