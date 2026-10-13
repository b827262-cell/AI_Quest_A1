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
  /** Evidence from automatic intake; an explicit owner edit may intentionally correct it. */
  rawAnswer?: string;
  rawAnswerCapturedAt?: string;
  /** The learner's revisitable Google AI/Search result, never answer prose. */
  sourceUrl?: string;
  /** A local, display-oriented rendition derived from rawAnswer. */
  organizedAnswer?: string;
}

export const LEARNING_HISTORY_KEY = "ai-smartbook.student.learning-history.v1";
export const PENDING_RAW_ANSWER_KEY = "ai-smartbook.student.pending-raw-answer.v1";
export const LEARNING_HISTORY_MAX_ENTRIES = 50;
export const RAW_ANSWER_MAX_CHARS = 20_000;

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

export function isHistoryEntry(value: unknown): value is LearningHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LearningHistoryEntry>;
  return typeof entry.id === "string"
    && typeof entry.askedAt === "string"
    && typeof entry.question === "string"
    && typeof entry.category === "string"
    && typeof entry.sourceType === "string"
    && (entry.strategy === "google-ai" || entry.strategy === "api")
    && (entry.answer === undefined || typeof entry.answer === "string")
    && (entry.answerUpdatedAt === undefined || typeof entry.answerUpdatedAt === "string")
    && (entry.rawAnswer === undefined || typeof entry.rawAnswer === "string")
    && (entry.rawAnswerCapturedAt === undefined || typeof entry.rawAnswerCapturedAt === "string")
    && (entry.sourceUrl === undefined || typeof entry.sourceUrl === "string")
    && (entry.organizedAnswer === undefined || typeof entry.organizedAnswer === "string");
}

function save(entries: LearningHistoryEntry[], storage = browserStorage()): LearningHistoryEntry[] {
  const valid = entries
    .filter(isHistoryEntry)
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt));
  // Evidence must not disappear merely because the older, pending queue reaches
  // its convenience limit. Non-raw records keep the legacy bounded behaviour.
  const evidence = valid.filter((entry) => Boolean(entry.rawAnswer || entry.sourceUrl));
  const bounded = [...evidence, ...valid.filter((entry) => !entry.rawAnswer && !entry.sourceUrl).slice(0, LEARNING_HISTORY_MAX_ENTRIES)]
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt));
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

export function organizeRawAnswer(rawAnswer: string): string {
  // No provider, DOM, or cross-origin content is involved. Preserve words and
  // paragraphs while making pasted text readable on a narrow screen.
  return rawAnswer.trim().replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * A share target's URL/title are navigation metadata, never answer evidence.
 * Keep this deliberately narrow: an answer may contain a link, but a link by
 * itself (including the app's own origin) cannot become a raw answer.
 */
export function isUrlOnlyText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const unwrapped = unwrapSharedUrl(trimmed);
  return /^(?:https?:\/\/|www\.)[^\s<>]+$/iu.test(unwrapped);
}

export type SharedAnswerExtraction =
  | { status: "accepted"; rawAnswer: string }
  | { status: "no_text" | "url_only" };

/**
 * Extract only prose from a Web Share text field. `sharedUrl` is intentionally
 * consulted only to reject a duplicated payload; it is never a fallback value.
 */
export function extractSharedAnswerText(text: unknown, sharedUrl?: unknown): SharedAnswerExtraction {
  if (typeof text !== "string" || !text.trim()) return { status: "no_text" };
  const trimmed = text.trim();
  if (typeof sharedUrl === "string" && sharedUrl.trim() && trimmed === sharedUrl.trim()) return { status: "url_only" };
  if (isUrlOnlyText(trimmed)) return { status: "url_only" };

  // Android shares commonly append the source link after the selected answer.
  // Remove only a final standalone URL; prose before it remains the raw answer.
  const withoutTrailingUrl = trimmed
    .replace(/(?:\s|^)<(?:https?:\/\/|www\.)[^>]+>\s*$/iu, "")
    .replace(/(?:\s|^)(?:https?:\/\/|www\.)[^\s<>]+>?\s*$/iu, "")
    .trim();
  if (!withoutTrailingUrl || isUrlOnlyText(withoutTrailingUrl)) return { status: "url_only" };
  return { status: "accepted", rawAnswer: withoutTrailingUrl };
}

export interface GoogleAiSourceUrl {
  /** Exact shared URL (apart from surrounding share markup), retained for revisit. */
  sourceUrl: string;
  /** Decoded `q` parameter used solely to bind the source to its question. */
  question: string;
}

export function unwrapSharedUrl(value: string): string {
  let trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    trimmed = trimmed.slice(1, -1).trim();
    const pipeIndex = trimmed.indexOf("|");
    if (pipeIndex !== -1) trimmed = trimmed.slice(0, pipeIndex).trim();
  }
  return trimmed.replaceAll("&amp;", "&");
}

/**
 * Accept only an actual Google AI Mode search result.  Parsing validates the
 * URL, but the original shared spelling/query string is retained for revisit.
 */
export function parseGoogleAiSourceUrl(value: unknown): GoogleAiSourceUrl | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const sourceUrl = unwrapSharedUrl(value);
  try {
    const parsed = new URL(sourceUrl);
    // Safe source URL allowlist: HTTPS + exact www.google.com + pathname /search + udm=50.
    // Origin and component checks intentionally reject lookalike hosts, alternate
    // ports, HTTP, and credential-bearing URLs. We only retain an actual Google AI
    // Mode result URL, without fetching or reading any cross-origin content.
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.google.com") return null;
    if (parsed.port !== "" && parsed.port !== "443") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/search") return null;
    if (parsed.searchParams.get("udm") !== "50") return null;
    const question = parsed.searchParams.get("q")?.trim();
    return question ? { sourceUrl, question } : null;
  } catch {
    return null;
  }
}

/** Finds a trailing/shared safe Google URL without treating arbitrary links as evidence. */
export function extractGoogleAiSourceUrl(text: unknown, sharedUrl?: unknown): GoogleAiSourceUrl | null {
  const direct = parseGoogleAiSourceUrl(sharedUrl);
  if (direct) return direct;
  if (typeof text !== "string") return null;
  const candidates = text.match(/<?https:\/\/[^\s<>]+>?/giu) ?? [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = parseGoogleAiSourceUrl(candidates[index]);
    if (parsed) return parsed;
  }
  return null;
}

/** A Google result can bind only to one exact recorded Search Friend question. */
export function findGoogleAiSourceEntry(entries: LearningHistoryEntry[], source: GoogleAiSourceUrl): LearningHistoryEntry | null {
  const matches = entries.filter((entry) => entry.strategy === "google-ai" && normalizeQuestion(entry.question) === normalizeQuestion(source.question));
  if (matches.length === 1) return matches[0];
  // If multiple entries match the question, bind to the pending entry (one that does not yet have rawAnswer or sourceUrl)
  const pending = matches.filter((entry) => !entry.rawAnswer || !entry.sourceUrl);
  if (pending.length >= 1) return pending[0];
  return null;
}

export type SaveGoogleAiSourceUrlResult =
  | { status: "saved" | "already_saved"; entries: LearningHistoryEntry[] }
  | { status: "rejected_source_url" | "question_mismatch" | "not_found"; entries: LearningHistoryEntry[] };

/** Saves revisitable source metadata independently; it never changes raw answer evidence. */
export function saveGoogleAiSourceUrl(id: string, sourceUrl: unknown, storage = browserStorage()): SaveGoogleAiSourceUrlResult {
  const source = parseGoogleAiSourceUrl(sourceUrl);
  const entries = readLearningHistory(storage);
  const target = entries.find((entry) => entry.id === id);
  if (!source) return { status: "rejected_source_url", entries };
  if (!target) return { status: "not_found", entries };
  if (target.strategy !== "google-ai" || normalizeQuestion(target.question) !== normalizeQuestion(source.question)) {
    return { status: "question_mismatch", entries };
  }
  // A replay must be idempotent and a later share must not silently retarget a
  // question to another result. The original question-bound URL is evidence.
  if (target.sourceUrl) return { status: "already_saved", entries };
  return { status: "saved", entries: save(entries.map((entry) => entry.id === id ? { ...entry, sourceUrl: source.sourceUrl } : entry), storage) };
}

export type SaveRawAnswerOnceResult =
  | { status: "saved"; entries: LearningHistoryEntry[] }
  | { status: "already_imported"; entries: LearningHistoryEntry[] }
  | { status: "rejected_url_only"; entries: LearningHistoryEntry[] }
  | { status: "not_found"; entries: LearningHistoryEntry[] };

export function saveRawAnswerOnce(id: string, rawAnswer: string, storage = browserStorage()): SaveRawAnswerOnceResult {
  const capped = rawAnswer.slice(0, RAW_ANSWER_MAX_CHARS);
  const entries = readLearningHistory(storage);
  const target = entries.find((entry) => entry.id === id);
  if (!target || !capped.trim()) return { status: "not_found", entries };
  // Defense in depth for every intake path, including manual/clipboard UI.
  if (isUrlOnlyText(capped)) return { status: "rejected_url_only", entries };
  if (target.rawAnswer) return { status: "already_imported", entries };
  const capturedAt = new Date().toISOString();
  return { status: "saved", entries: save(entries.map((entry) => {
    if (entry.id !== id) return entry;
    return { ...entry, rawAnswer: capped, rawAnswerCapturedAt: capturedAt, organizedAnswer: organizeRawAnswer(capped) };
  }), storage) };
}

export type UpdateLearningHistoryContentResult =
  | { status: "saved"; entries: LearningHistoryEntry[] }
  | { status: "rejected_url_only" | "rejected_source_url" | "question_mismatch" | "not_found"; entries: LearningHistoryEntry[] };

/**
 * Intentional, user-initiated correction path for one stored record. Unlike
 * share/replay intake this may replace or remove evidence, but it still uses
 * the exact Google AI source parser and never changes record identity.
 */
export function updateLearningHistoryContent(
  id: string,
  content: { rawAnswer: string; sourceUrl: string },
  storage = browserStorage()
): UpdateLearningHistoryContentResult {
  const entries = readLearningHistory(storage);
  const target = entries.find((entry) => entry.id === id);
  if (!target) return { status: "not_found", entries };

  const rawAnswer = content.rawAnswer.slice(0, RAW_ANSWER_MAX_CHARS);
  // Edit mode is an explicit writer, but rawAnswer remains answer prose rather
  // than navigation metadata. Reuse the intake guard before any mutation.
  if (isUrlOnlyText(rawAnswer)) return { status: "rejected_url_only", entries };
  const sourceInput = content.sourceUrl.trim();
  const source = sourceInput ? parseGoogleAiSourceUrl(sourceInput) : null;
  if (sourceInput && !source) return { status: "rejected_source_url", entries };
  if (source && (target.strategy !== "google-ai" || normalizeQuestion(target.question) !== normalizeQuestion(source.question))) {
    return { status: "question_mismatch", entries };
  }

  const hasRawAnswer = Boolean(rawAnswer.trim());
  const entriesWithUpdate = entries.map((entry) => {
    if (entry.id !== id) return entry;
    const next: LearningHistoryEntry = { ...entry };
    if (hasRawAnswer) {
      next.rawAnswer = rawAnswer;
      next.organizedAnswer = organizeRawAnswer(rawAnswer);
      if (entry.rawAnswer !== rawAnswer) next.rawAnswerCapturedAt = new Date().toISOString();
    } else {
      delete next.rawAnswer;
      delete next.rawAnswerCapturedAt;
      delete next.organizedAnswer;
    }
    if (source) next.sourceUrl = source.sourceUrl;
    else delete next.sourceUrl;
    return next;
  });
  return { status: "saved", entries: save(entriesWithUpdate, storage) };
}

export function normalizeQuestion(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-TW").replace(/[\s\p{P}\p{S}_]+/gu, "");
}

export interface AnswerBinding {
  matches: LearningHistoryEntry[];
  highConfidenceMatches: LearningHistoryEntry[];
  hasExplicitMismatch: boolean;
}

/** Finds only unanswered Search Friend records; callers must ask before a choice is ambiguous. */
function meaningfulQuestionTokens(value: string): string[] {
  const normalized = normalizeQuestion(value);
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const han = normalized.match(/\p{Script=Han}+/gu)?.flatMap((word) =>
    Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))
  ) ?? [];
  // These are question scaffolding, not evidence that an answer concerns a
  // particular pending question. In particular, 「什麼」must never bind a reply.
  const interrogatives = new Set(["什麼", "麼是", "請問", "如何", "怎麼", "為何", "是否", "哪裡", "哪些", "哪個", "問題"]);
  return [...new Set([...latin, ...han])].filter((token) => !interrogatives.has(token));
}

export type AnswerRelationConfidence = "none" | "weak" | "high";

/**
 * Conservative local-only evidence check. A reply needs at least two distinct
 * non-interrogative fragments and proportionate coverage before it is even a
 * chooser candidate; automatic binding has a stricter threshold.
 */
export function answerRelationConfidence(question: string, rawAnswer: string): AnswerRelationConfidence {
  const answer = normalizeQuestion(rawAnswer);
  const normalizedQuestion = normalizeQuestion(question);
  if (!answer || !normalizedQuestion) return "none";
  if (normalizedQuestion.length >= 6 && answer.includes(normalizedQuestion)) return "high";
  const tokens = meaningfulQuestionTokens(question).filter((token) => token.length >= 2);
  const hitCount = tokens.filter((token) => answer.includes(token)).length;
  const candidateThreshold = Math.max(2, Math.ceil(tokens.length * 0.34));
  if (hitCount < candidateThreshold) return "none";
  const highConfidenceThreshold = Math.max(2, Math.ceil(tokens.length * 0.67));
  return hitCount >= highConfidenceThreshold ? "high" : "weak";
}

export function hasPlausibleAnswerRelation(question: string, rawAnswer: string): boolean {
  return answerRelationConfidence(question, rawAnswer) !== "none";
}

export function findAnswerBinding(entries: LearningHistoryEntry[], rawAnswer: string): AnswerBinding {
  const pending = entries.filter((entry) => entry.strategy === "google-ai" && !entry.rawAnswer);
  const relations = pending.map((entry) => ({ entry, confidence: answerRelationConfidence(entry.question, rawAnswer) }));
  const matches = relations.filter(({ confidence }) => confidence !== "none").map(({ entry }) => entry).slice(0, 3);
  const highConfidenceMatches = relations.filter(({ confidence }) => confidence === "high").map(({ entry }) => entry).slice(0, 3);
  return { matches, highConfidenceMatches, hasExplicitMismatch: matches.length === 0 };
}

/** The page may auto-bind only one genuinely high-confidence candidate. */
export function canAutoBindAnswer(binding: AnswerBinding): boolean {
  return binding.matches.length === 1
    && binding.highConfidenceMatches.length === 1
    && binding.matches[0]?.id === binding.highConfidenceMatches[0]?.id;
}

export interface PendingRawAnswer {
  rawAnswer: string;
}

function isPendingRawAnswer(value: unknown): value is PendingRawAnswer {
  return Boolean(value) && typeof value === "object" && typeof (value as PendingRawAnswer).rawAnswer === "string";
}

/** Keeps one unbound share locally until the learner explicitly binds or discards it. */
export function readPendingRawAnswer(storage = browserStorage()): PendingRawAnswer | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PENDING_RAW_ANSWER_KEY) ?? "null");
    return isPendingRawAnswer(parsed) && parsed.rawAnswer.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export function savePendingRawAnswerOnce(rawAnswer: string, storage = browserStorage()): PendingRawAnswer | null {
  const existing = readPendingRawAnswer(storage);
  if (existing) return existing;
  const pending = { rawAnswer: rawAnswer.slice(0, RAW_ANSWER_MAX_CHARS) };
  if (!pending.rawAnswer.trim()) return null;
  try {
    storage?.setItem(PENDING_RAW_ANSWER_KEY, JSON.stringify(pending));
  } catch {
    // The caller still retains this intake in memory if storage is unavailable.
  }
  return pending;
}

export function clearPendingRawAnswer(storage = browserStorage()): void {
  try {
    storage?.removeItem(PENDING_RAW_ANSWER_KEY);
  } catch {
    // A blocked storage implementation cannot affect the current UI state.
  }
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
