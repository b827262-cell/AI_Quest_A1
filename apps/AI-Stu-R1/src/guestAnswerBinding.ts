import type { GuestAnswerCredential } from "./guestAnswerNavigation";
import type { GuestAskResponse } from "./studentClient";

export type GuestAnswerBindingSession = {
  routeResponse?: GuestAskResponse;
  credential?: GuestAnswerCredential;
  shouldRecoverSavedAnswer: boolean;
  credentialMatchesRoute: boolean;
  isCurrent: () => boolean;
  acceptsSavedAnswer: (saved: GuestAskResponse) => boolean;
  cancel: () => void;
};

export type GuestAnswerBindingCoordinator = {
  begin: (
    routeResponse: GuestAskResponse | undefined,
    credential: GuestAnswerCredential | null
  ) => GuestAnswerBindingSession;
};

/**
 * Keeps every rendered question/answer pair bound to one request ID.
 * Starting a new route session immediately invalidates all older recovery
 * promises, even if those promises settle after the new answer is rendered.
 */
export function createGuestAnswerBindingCoordinator(): GuestAnswerBindingCoordinator {
  let revision = 0;

  return {
    begin(routeResponse, credentialValue) {
      const sessionRevision = ++revision;
      const credential = credentialValue ?? undefined;
      const routeRequestId = routeResponse?.requestId;
      const credentialMatchesRoute =
        !routeResponse || !credential || credential.requestId === routeRequestId;
      const shouldRecoverSavedAnswer = !routeResponse && Boolean(credential);
      const expectedRequestId = routeRequestId || credential?.requestId;
      const isCurrent = () => revision === sessionRevision;

      return {
        routeResponse,
        credential,
        shouldRecoverSavedAnswer,
        credentialMatchesRoute,
        isCurrent,
        acceptsSavedAnswer: (saved) =>
          isCurrent() &&
          shouldRecoverSavedAnswer &&
          Boolean(expectedRequestId) &&
          saved.requestId === expectedRequestId,
        cancel: () => {
          if (isCurrent()) revision += 1;
        }
      };
    }
  };
}

export function hasDisplayableGuestAnswer(response: GuestAskResponse): boolean {
  return Boolean(response.answer || response.structuredAnswer);
}
