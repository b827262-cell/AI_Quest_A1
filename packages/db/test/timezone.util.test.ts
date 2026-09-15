import { describe, expect, it } from "vitest";
import {
  localMidnightUtc,
  localParts,
  nextDailyReset
} from "../src/repositories/timezone.util";

describe("daily quota timezone boundaries", () => {
  it.each([
    ["UTC", 2026, 9, 15, "2026-09-15T00:00:00.000Z"],
    ["Asia/Taipei", 2026, 9, 15, "2026-09-14T16:00:00.000Z"],
    ["Asia/Kathmandu", 2026, 9, 15, "2026-09-14T18:15:00.000Z"],
    ["America/New_York", 2026, 3, 9, "2026-03-09T04:00:00.000Z"],
    ["America/New_York", 2026, 11, 2, "2026-11-02T05:00:00.000Z"]
  ])("finds the exact start of %s local date", (timezone, year, month, day, expected) => {
    const boundary = localMidnightUtc(year, month, day, timezone);
    expect(boundary.toISOString()).toBe(expected);
    expect(localParts(boundary, timezone)).toMatchObject({
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0
    });
  });

  it("uses the first valid instant when DST skips local midnight", () => {
    const boundary = localMidnightUtc(2026, 9, 6, "America/Santiago");
    expect(boundary.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localParts(boundary, "America/Santiago")).toMatchObject({
      year: 2026,
      month: 9,
      day: 6,
      hour: 1,
      minute: 0,
      second: 0
    });
  });

  it("never returns an already-expired reset around a skipped-midnight transition", () => {
    const now = new Date("2026-09-06T02:30:45.123Z");
    const reset = new Date(nextDailyReset(now, "America/Santiago"));
    expect(reset.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it("advances across a historically skipped calendar date", () => {
    const boundary = localMidnightUtc(2011, 12, 30, "Pacific/Apia");
    expect(boundary.toISOString()).toBe("2011-12-30T10:00:00.000Z");
    expect(localParts(boundary, "Pacific/Apia")).toMatchObject({
      year: 2011,
      month: 12,
      day: 31,
      hour: 0,
      minute: 0,
      second: 0
    });
  });
});
