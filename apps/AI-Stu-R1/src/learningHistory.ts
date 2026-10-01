import type { GuestQuestionCategory } from "./studentClient";

export type AnswerStrategy = "google-ai" | "api";
export type LearningSourceType = "manual" | "image" | "file";

export interface LearningHistoryEntry {
  id: string;
  askedAt: string;
  question: string;
  category: GuestQuestionCategory;
  sourceType: LearningSourceType;
  strategy: AnswerStrategy;
  answer?: string;
  answerUpdatedAt?: string;
}

export const LEARNING_HISTORY_KEY = "ai-smartbook.student.learning-history.v1";
export const LEARNING_HISTORY_MAX_ENTRIES = 50;

export function googleAiSearchUrl(question: string): string {
  return `https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=${encodeURIComponent(question)}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isHistoryEntry(value: unknown): value is LearningHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LearningHistoryEntry>;
  return typeof entry.id === "string"
    && typeof entry.askedAt === "string"
    && typeof entry.question === "string"
    && typeof entry.category === "string"
    && typeof entry.sourceType === "string"
    && (entry.strategy === "google-ai" || entry.strategy === "api");
}

function save(entries: LearningHistoryEntry[], storage = browserStorage()): LearningHistoryEntry[] {
  const bounded = entries
    .filter(isHistoryEntry)
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
    .slice(0, LEARNING_HISTORY_MAX_ENTRIES);
  if (!storage) return bounded;
  try {
    storage.setItem(LEARNING_HISTORY_KEY, JSON.stringify(bounded));
  } catch {
    // Storage can be unavailable in private browsing or when it is full.
  }
  return bounded;
}

export function readLearningHistory(storage = browserStorage()): LearningHistoryEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEARNING_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? save(parsed.filter(isHistoryEntry), storage) : [];
  } catch {
    return [];
  }
}

function newHistoryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `learning-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function addLearningHistoryEntry(
  input: Omit<LearningHistoryEntry, "id" | "askedAt" | "answer" | "answerUpdatedAt">,
  storage = browserStorage()
): { entry: LearningHistoryEntry; entries: LearningHistoryEntry[] } {
  const entry: LearningHistoryEntry = {
    ...input,
    id: newHistoryId(),
    askedAt: new Date().toISOString()
  };
  return { entry, entries: save([entry, ...readLearningHistory(storage)], storage) };
}

export function updateLearningHistoryAnswer(id: string, answer: string, storage = browserStorage()): LearningHistoryEntry[] {
  const updatedAt = new Date().toISOString();
  return save(readLearningHistory(storage).map((entry) => entry.id === id
    ? { ...entry, answer: answer || undefined, answerUpdatedAt: answer ? updatedAt : undefined }
    : entry), storage);
}

export function removeLearningHistoryEntry(id: string, storage = browserStorage()): LearningHistoryEntry[] {
  return save(readLearningHistory(storage).filter((entry) => entry.id !== id), storage);
}

export function clearLearningHistory(storage = browserStorage()): LearningHistoryEntry[] {
  if (storage) {
    try {
      storage.removeItem(LEARNING_HISTORY_KEY);
    } catch {
      // Keep the in-memory UI empty even if browser storage rejects the write.
    }
  }
  return [];
}
