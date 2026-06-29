import type {
  AppearanceSettings,
  Book,
  BookChapter,
  BookContent,
  ChatMessage,
  CreateSmartBookNoteInput,
  ReaderOutlineResponse,
  SmartBookNote,
  UpdateSmartBookNoteInput
} from "@ai-smartbook/schema";

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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function httpWithSession<T>(path: string, sessionId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set("X-Student-Session-Id", sessionId);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchPdfBlob(path: string, sessionId: string): Promise<Blob> {
  const res = await fetch(path, {
    headers: { "X-Student-Session-Id": sessionId },
    cache: "no-store"
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return await res.blob();
}

/**
 * Student-facing API client. It only talks to /api/student/* — it never stores
 * an API key and never calls an AI SDK directly.
 */
export const studentClient = {
  listBooks: () => http<{ mode: string; books: Book[] }>("/api/student/books"),

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
    )
};
