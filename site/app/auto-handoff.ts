/**
 * A5 owns the only external handoff in public Auto answers.
 *
 * The blank tab must be opened in the synchronous submit gesture; delayed
 * window.open calls are popup-blocked by browsers. We never inspect the
 * destination and only carry the learner's original question in the URL.
 */
import { buildGoogleAiModeUrl } from "./auto-fallback";

export type HandoffTab = {
  closed?: boolean;
  /**
   * A just-opened about:blank tab inherits its opener. Clear it while the
   * synchronous gesture is still active, but retain this parent-held proxy so
   * the parent can later close the local-success tab or replace it on handoff.
   */
  opener?: unknown;
  close(): void;
  location: { replace(url: string): void };
};

export type HandoffWindow = {
  open(url?: string, target?: string): HandoffTab | null;
  location: { replace(url: string): void; assign?(url: string): void };
};

/** Open only after a failed local answer, avoiding a blank tab during inference. */
export function openGoogleAiAfterLocalFailure(
  originalQuestion: string,
  browser: HandoffWindow,
): "new-tab" | "current-tab" {
  const googleAiUrl = buildGoogleAiModeUrl(originalQuestion);
  // An asynchronous model failure may lose user activation. Try a new tab,
  // then navigate this tab if the browser blocks the popup.
  const tab = browser.open("about:blank", "_blank");
  if (tab) {
    tab.opener = null;
    tab.location.replace(googleAiUrl);
    return "new-tab";
  }
  if (browser.location.assign) browser.location.assign(googleAiUrl);
  else browser.location.replace(googleAiUrl);
  return "current-tab";
}

/** Call directly from the submit event, before the first await. */
export function preopenGoogleAiTab(browser: HandoffWindow): HandoffTab | null {
  const tab = browser.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/** A gate-passed local answer leaves no blank browser tab behind. */
export function closePreopenedGoogleAiTab(tab: HandoffTab | null): void {
  if (tab && !tab.closed) tab.close();
}

/**
 * Send exactly one navigation to Google AI Mode. If the browser blocked the
 * pre-opened tab, fall back once in the current tab; do not open or render a
 * second manual-route affordance.
 */
export function handoffToGoogleAi(
  originalQuestion: string,
  tab: HandoffTab | null,
  browser: HandoffWindow,
): "preopened-tab" | "popup-blocked-fallback" {
  const googleAiUrl = buildGoogleAiModeUrl(originalQuestion);
  if (tab && !tab.closed) {
    tab.location.replace(googleAiUrl);
    return "preopened-tab";
  }
  browser.location.replace(googleAiUrl);
  return "popup-blocked-fallback";
}
