import type { Book } from "@ai-smartbook/schema";
import type { StudentProfile } from "@ai-smartbook/auth/browser";
import {
  studentClient,
  type GuestAskResponse,
  type GuestQuestionCategory
} from "../studentClient";

export interface DashboardProfile {
  name: string | null;
  points: number | null;
  authenticated: boolean;
}

/**
 * Derive the dashboard view-model exclusively from the server session
 * profile exposed by useStudentAuth(). The browser never supplies identity:
 * localStorage self-declared names/points are not an auth source.
 */
export function dashboardProfileFromSession(profile: StudentProfile | null): DashboardProfile {
  if (!profile) return { name: null, points: null, authenticated: false };
  return {
    name: profile.displayName.trim() || null,
    // The session contract does not expose a points balance yet; render a
    // neutral state instead of inventing a client-side value.
    points: null,
    authenticated: true
  };
}

/** Read the existing student book contract through the shared client. */
export async function loadDashboardBooks(): Promise<Book[]> {
  const response = await studentClient.listBooks();
  return response.books;
}

/** Submit the public guest-ask contract without exposing transport details to UI. */
export async function askDashboardGuestQuestion(
  question: string,
  category: GuestQuestionCategory = "auto"
): Promise<GuestAskResponse> {
  return studentClient.askAsGuest({
    question,
    category,
    sourceType: "manual",
    providerPreference: "auto"
  });
}

export async function sendDashboardGuestFeedback(
  requestId: string,
  helpful: boolean
): Promise<void> {
  await studentClient.sendGuestFeedback({ requestId, helpful });
}
