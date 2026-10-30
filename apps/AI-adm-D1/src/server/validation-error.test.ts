import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { failValidation } from "./validation-error";

describe("validation error response", () => {
  it("exposes nested field paths without validator messages or rejected input", () => {
    const parsed = z.object({ items: z.array(z.object({ name: z.string().min(3) })) }).safeParse({ items: [{ name: "x" }] });
    if (parsed.success) throw new Error("expected validation failure");
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    failValidation({ status } as unknown as Response, parsed.error);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "請求內容格式不正確", code: "invalid_request", fields: ["items.0.name"] });
  });
});
