import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestAnswerTimer,
  GUEST_EXTENDED_WAIT_AFTER_MS,
  GUEST_MAX_WAIT_MS
} from "./guestAnswerRequest";

afterEach(() => {
  vi.useRealTimers();
});

describe("guest answer request timer", () => {
  it("opens the extended wait once at 90 seconds and times out at 150 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const events: string[] = [];
    const timer = createGuestAnswerTimer({
      onExtendedWait: () => events.push("extended"),
      onTimeout: () => events.push("timeout")
    });

    vi.advanceTimersByTime(GUEST_EXTENDED_WAIT_AFTER_MS - 1);
    expect(events).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(events).toEqual(["extended"]);

    timer.acknowledgeExtendedWait();
    vi.advanceTimersByTime(GUEST_MAX_WAIT_MS - GUEST_EXTENDED_WAIT_AFTER_MS - 1);
    expect(events).toEqual(["extended"]);

    vi.advanceTimersByTime(1);
    expect(events).toEqual(["extended", "timeout"]);
    expect(timer.isActive()).toBe(false);
  });

  it("does not reopen the modal after continue and never starts a second request", () => {
    vi.useFakeTimers();
    const askAsGuest = vi.fn();
    const events: string[] = [];
    const timer = createGuestAnswerTimer({
      onExtendedWait: () => events.push("extended"),
      onTimeout: () => events.push("timeout")
    });

    vi.advanceTimersByTime(GUEST_EXTENDED_WAIT_AFTER_MS);
    timer.acknowledgeExtendedWait();
    vi.advanceTimersByTime(GUEST_MAX_WAIT_MS - GUEST_EXTENDED_WAIT_AFTER_MS);
    expect(events).toEqual(["extended", "timeout"]);
    expect(askAsGuest).not.toHaveBeenCalled();
  });

  it("cancels both boundaries so a stopped request cannot timeout later", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const timer = createGuestAnswerTimer({
      onExtendedWait: () => events.push("extended"),
      onTimeout: () => events.push("timeout")
    });

    timer.cancel();
    vi.advanceTimersByTime(GUEST_MAX_WAIT_MS);
    expect(events).toEqual([]);
    expect(timer.isActive()).toBe(false);
  });

  it("completion wins the timer race and ignores a late timeout", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const timer = createGuestAnswerTimer({
      onExtendedWait: () => events.push("extended"),
      onTimeout: () => events.push("timeout")
    });

    vi.advanceTimersByTime(GUEST_EXTENDED_WAIT_AFTER_MS);
    timer.complete();
    vi.advanceTimersByTime(GUEST_MAX_WAIT_MS);
    expect(events).toEqual(["extended"]);
    expect(timer.isActive()).toBe(false);
  });
});
