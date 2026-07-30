import { afterEach, describe, expect, it } from "vitest";
import {
  clearGuestAnswerCredential,
  GUEST_ANSWER_KEY,
  publicGuestAnswerForHistory,
  readGuestAnswerCredential,
  saveGuestAnswerCredential
} from "./guestAnswerNavigation";
import type { GuestAskResponse } from "./studentClient";

const originalWindow = globalThis.window;

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear()
  } as unknown as Storage;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage }
  });
  return storage;
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("guest answer navigation state", () => {
  it("stores and clears only the active answer reference", () => {
    const storage = installStorage();
    saveGuestAnswerCredential({ requestId: "guest_123", recoveryToken: "token_123" });
    expect(readGuestAnswerCredential()).toEqual({ requestId: "guest_123", recoveryToken: "token_123" });
    clearGuestAnswerCredential();
    expect(storage.getItem(GUEST_ANSWER_KEY)).toBeNull();
    expect(readGuestAnswerCredential()).toBeNull();
  });

  it("drops legacy references that cannot safely restore an answer", () => {
    const storage = installStorage();
    storage.setItem(GUEST_ANSWER_KEY, "guest_legacy_only");
    expect(readGuestAnswerCredential()).toBeNull();
    expect(storage.getItem(GUEST_ANSWER_KEY)).toBeNull();
  });

  it("never places the recovery token in browser history state", () => {
    const response: GuestAskResponse = {
      requestId: "guest_123",
      recoveryToken: "token_123",
      status: "incomplete",
      question: "第一題",
      answer: "回答"
    };
    const historyState = publicGuestAnswerForHistory(response);
    expect(historyState).toMatchObject({ requestId: "guest_123", answer: "回答" });
    expect(historyState.recoveryToken).toBeUndefined();
  });
});
