import type { Book } from "@ai-smartbook/schema";
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
 * The current auth foundation exposes a lightweight browser profile only.
 * Keep that adapter at the query boundary until a session contract is ready;
 * the dashboard must not invent a session or OAuth response shape.
 */
export function readDashboardProfile(): DashboardProfile {
  if (typeof window === "undefined") {
    return { name: null, points: null, authenticated: false };
  }

  const name = (
    window.localStorage.getItem("smartbook.student.name") ||
    window.localStorage.getItem("studentName") ||
    ""
  ).trim();
  const rawPoints = (
    window.localStorage.getItem("smartbook.student.points") ||
    window.localStorage.getItem("studentPoints") ||
    ""
  ).trim();
  const parsedPoints = rawPoints === "" ? Number.NaN : Number(rawPoints);

  return {
    name: name || null,
    points: Number.isFinite(parsedPoints) ? parsedPoints : null,
    authenticated: Boolean(name)
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
