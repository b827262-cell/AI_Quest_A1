import { describe, expect, it } from "vitest";
import { parseAnalyticsRange, isValidDateOnly } from "./analytics-query";

describe("analytics query validation", () => {
  it("rejects malformed and impossible calendar dates", () => {
    expect(isValidDateOnly("2026-02-29")).toBe(false);
    expect(isValidDateOnly("2026-2-1")).toBe(false);
    expect(isValidDateOnly("2026-02-28")).toBe(true);
  });

  it("uses Asia/Taipei day boundaries and rejects reversed ranges", () => {
    const range = parseAnalyticsRange("2026-07-22", "2026-07-23");
    expect(range).toEqual({
      ok: true,
      fromIso: "2026-07-21T16:00:00.000Z",
      toIso: "2026-07-23T15:59:59.999Z"
    });
    expect(parseAnalyticsRange("2026-07-24", "2026-07-23")).toMatchObject({
      ok: false,
      error: "from must not be after to"
    });
  });

  it("defaults omitted dates to the supplied local today", () => {
    expect(parseAnalyticsRange(undefined, undefined, "2026-07-23")).toMatchObject({
      ok: true,
      fromIso: "2026-07-22T16:00:00.000Z",
      toIso: "2026-07-23T15:59:59.999Z"
    });
  });
});
