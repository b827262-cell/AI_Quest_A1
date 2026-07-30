import type { GuestAskResponse } from "./studentClient";

export const GUEST_ANSWER_KEY = "smartbook.public.guest-answer";

export type GuestAnswerCredential = { requestId: string; recoveryToken: string };

export function saveGuestAnswerCredential(cred: GuestAnswerCredential): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(GUEST_ANSWER_KEY, JSON.stringify(cred));
}

export function readGuestAnswerCredential(): GuestAnswerCredential | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(GUEST_ANSWER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GuestAnswerCredential>;
    if (parsed && typeof parsed.requestId === "string" && typeof parsed.recoveryToken === "string") {
      return { requestId: parsed.requestId, recoveryToken: parsed.recoveryToken };
    }
  } catch {
    // Legacy or malformed values are not recoverable.
  }
  window.localStorage.removeItem(GUEST_ANSWER_KEY);
  return null;
}

export function clearGuestAnswerCredential(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(GUEST_ANSWER_KEY);
}

/** History state may contain the answer for immediate rendering, never its recovery token. */
export function publicGuestAnswerForHistory(response: GuestAskResponse): GuestAskResponse {
  const { recoveryToken: _recoveryToken, ...publicResponse } = response;
  return publicResponse;
}
