import { describe, expect, it } from "vitest";
import { createGuestAnswerBindingCoordinator } from "./guestAnswerBinding";
import type { GuestAskResponse } from "./studentClient";

function response(requestId: string, question: string, answer: string): GuestAskResponse {
  return { requestId, question, answer, status: "success" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("guest answer request binding", () => {
  it("uses fresh route state without starting saved-answer recovery", () => {
    const coordinator = createGuestAnswerBindingCoordinator();
    const fresh = response("guest_new", "Farmer Latif", "C++17 answer");
    const session = coordinator.begin(fresh, {
      requestId: "guest_new",
      recoveryToken: "token_new"
    });

    expect(session.routeResponse).toBe(fresh);
    expect(session.credentialMatchesRoute).toBe(true);
    expect(session.shouldRecoverSavedAnswer).toBe(false);
    expect(session.acceptsSavedAnswer(fresh)).toBe(false);
  });

  it("rejects and identifies a stale credential for a different route request", () => {
    const coordinator = createGuestAnswerBindingCoordinator();
    const fresh = response("guest_new", "Farmer Latif", "C++17 answer");
    const session = coordinator.begin(fresh, {
      requestId: "guest_old",
      recoveryToken: "token_old"
    });

    expect(session.credentialMatchesRoute).toBe(false);
    expect(session.shouldRecoverSavedAnswer).toBe(false);
    expect(session.acceptsSavedAnswer(response("guest_old", "Lemonade Change", "Python answer"))).toBe(false);
  });

  it("accepts saved recovery only when it matches the credential request ID", () => {
    const coordinator = createGuestAnswerBindingCoordinator();
    const session = coordinator.begin(undefined, {
      requestId: "guest_saved",
      recoveryToken: "token_saved"
    });

    expect(session.shouldRecoverSavedAnswer).toBe(true);
    expect(session.acceptsSavedAnswer(response("guest_saved", "Saved question", "Saved answer"))).toBe(true);
    expect(session.acceptsSavedAnswer(response("guest_other", "Other question", "Other answer"))).toBe(false);
  });

  it("ignores an older saved-answer promise that settles after newer route state", async () => {
    const coordinator = createGuestAnswerBindingCoordinator();
    const oldSaved = deferred<GuestAskResponse>();
    const oldSession = coordinator.begin(undefined, {
      requestId: "guest_old",
      recoveryToken: "token_old"
    });
    let rendered = response("guest_new", "Farmer Latif", "C++17 answer");
    const oldSettlement = oldSaved.promise.then((saved) => {
      if (oldSession.acceptsSavedAnswer(saved)) rendered = saved;
    });

    coordinator.begin(rendered, {
      requestId: "guest_new",
      recoveryToken: "token_new"
    });
    oldSaved.resolve(response("guest_old", "Lemonade Change", "Python answer"));
    await oldSettlement;

    expect(rendered.requestId).toBe("guest_new");
    expect(rendered.question).toBe("Farmer Latif");
    expect(rendered.answer).toBe("C++17 answer");
  });
});
