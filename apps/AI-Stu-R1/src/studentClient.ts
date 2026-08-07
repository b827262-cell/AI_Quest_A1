import type {
  AppearanceSettings,
  Book,
  BookChapter,
  BookContent,
  ChatMessage,
  CreateSmartBookNoteInput,
  ReaderOutlineResponse,
  SmartBookNote,
  UpdateSmartBookNoteInput,
  GuestAnswerContent
} from "@ai-smartbook/schema";
import type {
  StudentAuthMeResponse,
  StudentProfile
} from "@ai-smartbook/auth/browser";

export { type StudentAuthMeResponse, type StudentProfile } from "@ai-smartbook/auth/browser";

export interface PublicSiteConfig {
  siteTitle: string;
  siteSubtitle: string;
  homeGreeting: string;
  homeInputPlaceholder: string;
  guestAiEnabled: boolean;
  guestDailyLimit: number;
  studentLoginEnabled: boolean;
  maintenanceNotice: string;
}

export type GuestQuestionCategory =
  | "auto"
  | "programming"
  | "math"
  | "humanities"
  | "cybersecurity"
  | "教材問答";
export type GuestProviderPreference = "auto" | "openai" | "gemini" | "kimi" | "qwen";

export type GuestAnswerStatus =
  | "success"
  | "incomplete"
  | "limit_reached"
  | "rate_limited"
  | "disabled"
  | "error";

export interface GuestAskResponse {
  requestId: string;
  question?: string;
  status: GuestAnswerStatus;
  answer?: string;
  message?: string;
  remainingGuestQuestions?: number;
  requiresLoginForMore?: boolean;
  retryAfterSeconds?: number;
  retryable?: boolean;
  mode?: "live" | "mock";
  /** Structured, allowlisted learning content preferred by the renderer. */
  structuredAnswer?: GuestAnswerContent;
  /**
   * One-time high-entropy recovery token, returned ONLY when a new answer is
   * created. The client must persist it to restore the answer after a refresh.
   * It is never returned by the recovery endpoint and must never be logged.
   */
  recoveryToken?: string;
}

export interface BookDetail extends Book {
  chapters: BookChapter[];
  pdfFileId?: string | null;
  pdfFileName?: string | null;
}

export interface ChatResponse {
  sessionId: string;
  answer: string;
  chatMode: string;
  source?: string;
  provider?: string;
  model?: string;
  matchedQuestion?: string;
  messages: ChatMessage[];
}

export type ReaderProgressEventType = "page_view" | "page_complete" | "chapter_complete" | "note_captured";
export type ReaderActionType = "current_page" | "current_chapter" | "note_captured";

export interface ReaderProgressSummary {
  bookId: string;
  currentPage: number | null;
  currentChapterId: string | null;
  completedPagesCount: number;
  completedChapterIds: string[];
  completionPercentage: number | null;
  updatedAt: string | null;
}

export type KnowledgePointStatus = "available" | "completed";

export type KnowledgePoint = {
  id: string;
  chapterId: string;
  title: string;
  summary: string;
  sourcePageStart: number | null;
  sourcePageEnd: number | null;
  importance: "low" | "medium" | "high";
  difficulty: "basic" | "intermediate" | "advanced";
  status: KnowledgePointStatus;
};

export type KnowledgePointsQuery = {
  chapterId?: string;
};

export interface SaveReaderProgressPayload {
  page?: number;
  chapterId?: string;
  eventType?: ReaderProgressEventType;
  source?: string;
}

export interface CompleteReaderActionPayload {
  actionType: ReaderActionType;
  page?: number;
  chapterId?: string;
  source?: string;
}

export class StudentApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "StudentApiError";
  }
}

/** Public success shape of POST /api/student/books/:bookId/rag-ask. */
export interface BookRagCitation {
  chunkId: string;
  label: string;
  locator?: string;
  start?: number;
  end?: number;
  evidenceQuote?: string;
  contentHash?: string;
  hashAlgorithm?: "sha256";
}

export interface BookRagEvidence {
  quote: string;
  contentHash: string;
  hashAlgorithm: "sha256";
  chunkId: string;
  start: number;
  end: number;
}

export type BookRagClaimStatus = "supported" | "unsupported";
export type BookRagClaimRiskCategory = "general" | "number" | "date" | "formula" | "proper_noun";

export interface BookRagClaim {
  claimId: string;
  text: string;
  answerStart: number;
  answerEnd: number;
  status: BookRagClaimStatus;
  riskCategory?: BookRagClaimRiskCategory;
  citationChunkIds: string[];
  evidence: BookRagEvidence[];
}

export interface BookRagAnswer {
  contractVersion: number;
  requestId: string;
  answer: string;
  citations: BookRagCitation[];
  confidence: "high" | "medium" | "low";
  grounding: "verified" | "unverified" | "abstained";
  citationStatus: "verified" | "not_checked" | "invalid";
  abstained: boolean;
  abstentionReason?: "NO_EVIDENCE" | "INJECTION_BLOCKED" | "INSUFFICIENT_EVIDENCE";
  claims?: BookRagClaim[];
  unsupportedClaimCount?: number;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    ...init
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new StudentApiError(res.status, data.error || "STUDENT_API_ERROR", data.message || data.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function httpWithSession<T>(path: string, sessionId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set("X-Student-Session-Id", sessionId);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, credentials: "same-origin", headers });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new StudentApiError(res.status, data.error || "STUDENT_API_ERROR", data.message || data.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function httpWithOptionalSession<T>(
  path: string,
  sessionId: string | undefined,
  init?: RequestInit
): Promise<T> {
  if (!sessionId) {
    return http<T>(path, init);
  }
  return httpWithSession<T>(path, sessionId, init);
}

async function fetchPdfBlob(path: string, sessionId: string): Promise<Blob> {
  const res = await fetch(path, {
    headers: { "X-Student-Session-Id": sessionId },
    cache: "no-store"
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(data.error || data.message || `${res.status} ${res.statusText}`);
  }
  return await res.blob();
}

/**
 * Student-facing API client. It only talks to /api/student/* — it never stores
 * an API key and never calls an AI SDK directly.
 */
export const studentClient = {
  getStudentMe: () => http<StudentAuthMeResponse>("/api/student/auth/me"),

  logoutStudent: () => http<void>("/api/student/auth/logout", { method: "POST" }),

  getStudentProfile: () => http<{ profile: StudentProfile }>("/api/student/auth/profile"),

  updateStudentProfile: (body: { displayName: string; schoolName: string; gradeLevel: string }) =>
    http<{ profile: StudentProfile }>("/api/student/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(body)
    }),

  getPublicSiteConfig: () => http<PublicSiteConfig>("/api/public/site-config"),

  askAsGuest: (body: {
    question: string;
    category: GuestQuestionCategory;
    sourceType: "manual" | "image" | "file";
    providerPreference?: GuestProviderPreference;
  }, signal?: AbortSignal) =>
    http<GuestAskResponse>("/api/public/guest-ask", {
      method: "POST",
      body: JSON.stringify(body),
      signal
    }),

  // Restore a saved guest answer. The recovery token is sent via a header
  // (never in the URL query string) and authorizes the restore; IP is not an
  // auth factor. This is a non-streaming JSON API.
  getSavedGuestAnswer: (requestId: string, recoveryToken: string) =>
    http<GuestAskResponse>(`/api/public/guest-ask/${encodeURIComponent(requestId)}`, {
      headers: { "x-guest-recovery-token": recoveryToken }
    }),

  sendGuestFeedback: (body: { requestId: string; helpful: boolean }) =>
    http<{ accepted: boolean }>("/api/public/guest-feedback", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  listBooks: () => http<{ mode: string; books: Book[] }>("/api/student/books"),

  /**
   * Scoped RAG question for a book. Identity/scope are injected server-side
   * from the session; the browser only supplies the query. Citations in the
   * response were already validated server-side and are safe to render.
   */
  askBookRag: async (bookId: string, body: { query: string; conversationId?: string }, signal?: AbortSignal): Promise<BookRagAnswer> => {
    const res = await fetch(`/api/student/books/${encodeURIComponent(bookId)}/rag-ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      signal
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const envelope = (data.error && typeof data.error === "object" ? data.error : {}) as { code?: unknown; message?: unknown };
      const code = typeof envelope.code === "string"
        ? envelope.code
        : typeof data.error === "string" ? data.error : "STUDENT_API_ERROR";
      const message = typeof envelope.message === "string" ? envelope.message : `${res.status} ${res.statusText}`;
      throw new StudentApiError(res.status, code, message);
    }
    return data as unknown as BookRagAnswer;
  },

  getBook: (bookId: string) => http<{ book: BookDetail }>(`/api/student/books/${bookId}`),

  getOutline: (bookId: string) =>
    http<ReaderOutlineResponse>(`/api/student/books/${bookId}/outline`),

  getContents: (bookId: string) =>
    http<{ contents: BookContent[] }>(`/api/student/books/${bookId}/contents`),

  ensureBookSession: (bookId: string, sessionId?: string | null) =>
    http<{ sessionId: string }>(`/api/student/books/${bookId}/session`, {
      method: "POST",
      body: JSON.stringify(sessionId ? { sessionId } : {})
    }),

  getProtectedPdfBlob: (bookId: string, fileId: string, sessionId: string) =>
    fetchPdfBlob(`/api/student/books/${bookId}/files/${fileId}/pdf-view`, sessionId),

  sendBookChat: (
    bookId: string,
    body: { message: string; sessionId?: string; chapterId?: string }
  ) =>
    http<ChatResponse>(`/api/student/books/${bookId}/chat`, {
      method: "POST",
      body: JSON.stringify(body)
    }),

  getBookChatSession: (bookId: string, sessionId: string) =>
    http<{ sessionId: string; messages: ChatMessage[] }>(
      `/api/student/books/${bookId}/chat-sessions/${sessionId}`
    ),

  getAppearanceSettings: () =>
    http<{ settings: AppearanceSettings }>("/api/appearance-settings"),

  // ---- Smart Notes -------------------------------------------------------
  listNotes: (bookId: string) =>
    http<{ notes: SmartBookNote[] }>(`/api/student/books/${bookId}/notes`),

  createNote: (bookId: string, input: CreateSmartBookNoteInput) =>
    http<{ note: SmartBookNote }>(`/api/student/books/${bookId}/notes`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  updateNote: (bookId: string, noteId: string, input: UpdateSmartBookNoteInput) =>
    http<{ note: SmartBookNote }>(`/api/student/books/${bookId}/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  deleteNote: (bookId: string, noteId: string) =>
    http<{ deleted: boolean }>(`/api/student/books/${bookId}/notes/${noteId}`, {
      method: "DELETE"
    }),

  getBookProgressSummary: (bookId: string, sessionId: string) =>
    httpWithSession<ReaderProgressSummary>(`/api/student/books/${bookId}/progress-summary`, sessionId),

  saveBookProgress: (bookId: string, payload: SaveReaderProgressPayload, sessionId: string) =>
    httpWithSession<ReaderProgressSummary>(
      `/api/student/books/${bookId}/progress`,
      sessionId,
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    ),

  completeReaderAction: (bookId: string, payload: CompleteReaderActionPayload, sessionId: string) =>
    httpWithSession<ReaderProgressSummary>(
      `/api/student/books/${bookId}/reader-actions/complete`,
      sessionId,
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    ),

  getKnowledgePoints: (
    bookId: string,
    params?: KnowledgePointsQuery,
    sessionId?: string
  ) => {
    const search = new URLSearchParams();
    if (params?.chapterId?.trim()) {
      search.set("chapterId", params.chapterId.trim());
    }
    const suffix = search.toString() ? `?${search}` : "";
    return httpWithOptionalSession<{
      bookId: string;
      chapterId?: string | null;
      points: KnowledgePoint[];
      completedPointsCount: number;
    }>(
      `/api/student/books/${bookId}/knowledge-points${suffix}`,
      sessionId
    );
  },

  getChapterKnowledgePoints: (bookId: string, chapterId: string, sessionId?: string) =>
    httpWithOptionalSession<{
      bookId: string;
      chapterId: string;
      points: KnowledgePoint[];
      completedPointsCount: number;
    }>(`/api/student/books/${bookId}/chapters/${chapterId}/knowledge-points`, sessionId),

  getKnowledgePoint: (bookId: string, pointId: string, sessionId?: string) =>
    httpWithOptionalSession<{
      bookId: string;
      point: KnowledgePoint;
    }>(`/api/student/books/${bookId}/knowledge-points/${pointId}`, sessionId),

  completeKnowledgePoint: (bookId: string, pointId: string, sessionId: string) =>
    httpWithSession<{
      bookId: string;
      point: KnowledgePoint;
      completedPointsCount: number;
    }>(`/api/student/books/${bookId}/knowledge-points/${pointId}/complete`, sessionId, {
      method: "POST",
      body: "{}"
    })
};
