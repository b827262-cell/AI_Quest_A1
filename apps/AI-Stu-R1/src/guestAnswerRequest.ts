export const GUEST_EXTENDED_WAIT_AFTER_MS = 90_000;
export const GUEST_MAX_WAIT_MS = 150_000;
export const GUEST_EXTENDED_WAIT_MS = GUEST_MAX_WAIT_MS - GUEST_EXTENDED_WAIT_AFTER_MS;
export const ANSWER_REVEAL_DELAY_MS = 400;

type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduleTimer = (callback: () => void, delayMs: number) => TimerHandle;
type CancelTimer = (handle: TimerHandle) => void;

export type GuestAnswerTimer = {
  startedAt: number;
  acknowledgeExtendedWait: () => void;
  complete: () => void;
  cancel: () => void;
  isActive: () => boolean;
};

export type GuestAnswerTimerOptions = {
  now?: () => number;
  schedule?: ScheduleTimer;
  cancelTimer?: CancelTimer;
  onExtendedWait: () => void;
  onTimeout: () => void;
};

/**
 * Owns the two client-side wait boundaries for one request.
 *
 * The timer is deliberately independent from React state: completion,
 * cancellation, timeout and late promise settlement can all invalidate the
 * same request without a second API call or a stale timer mutating a newer
 * request.
 */
export function createGuestAnswerTimer({
  now = Date.now,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelTimer = (handle) => clearTimeout(handle),
  onExtendedWait,
  onTimeout
}: GuestAnswerTimerOptions): GuestAnswerTimer {
  const startedAt = now();
  let active = true;
  let extendedWaitAcknowledged = false;
  let extendedTimer: TimerHandle | null = null;
  let timeoutTimer: TimerHandle | null = null;

  const clearTimers = () => {
    if (extendedTimer !== null) {
      cancelTimer(extendedTimer);
      extendedTimer = null;
    }
    if (timeoutTimer !== null) {
      cancelTimer(timeoutTimer);
      timeoutTimer = null;
    }
  };

  extendedTimer = schedule(() => {
    extendedTimer = null;
    if (!active || extendedWaitAcknowledged) return;
    onExtendedWait();
  }, GUEST_EXTENDED_WAIT_AFTER_MS);

  timeoutTimer = schedule(() => {
    timeoutTimer = null;
    if (!active) return;
    active = false;
    if (extendedTimer !== null) {
      cancelTimer(extendedTimer);
      extendedTimer = null;
    }
    onTimeout();
  }, GUEST_MAX_WAIT_MS);

  return {
    startedAt,
    acknowledgeExtendedWait: () => {
      if (active) extendedWaitAcknowledged = true;
    },
    complete: () => {
      if (!active) return;
      active = false;
      clearTimers();
    },
    cancel: () => {
      if (!active) return;
      active = false;
      clearTimers();
    },
    isActive: () => active
  };
}

