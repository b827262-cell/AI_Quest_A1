import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLearningHistoryEntry,
  clearLearningHistory,
  googleAiSearchUrl,
  LEARNING_HISTORY_KEY,
  LEARNING_HISTORY_MAX_ENTRIES,
  readLearningHistory,
  updateLearningHistoryAnswer
} from "./learningHistory";

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear()
  } as Storage;
}

afterEach(() => vi.useRealTimers());

describe("Google AI URL", () => {
  it("uses the zh-TW Google AI Mode URL and encodes the question", () => {
    expect(googleAiSearchUrl("什麼是 A&B？")).toBe(
      "https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=%E4%BB%80%E9%BA%BC%E6%98%AF%20A%26B%EF%BC%9F"
    );
  });
});

describe("local learning history", () => {
  it("persists answers beside their question and clears only this history key", () => {
    const storage = makeStorage();
    storage.setItem("unrelated", "keep");
    const { entry } = addLearningHistoryEntry({
      question: "第一題", category: "math", sourceType: "manual", strategy: "google-ai"
    }, storage);
    updateLearningHistoryAnswer(entry.id, "Google AI 解答", storage);

    expect(readLearningHistory(storage)[0]).toMatchObject({ question: "第一題", answer: "Google AI 解答" });
    clearLearningHistory(storage);
    expect(storage.getItem(LEARNING_HISTORY_KEY)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });

  it("keeps the newest bounded set of records", () => {
    const storage = makeStorage();
    vi.useFakeTimers();
    for (let index = 0; index < LEARNING_HISTORY_MAX_ENTRIES + 3; index += 1) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`));
      addLearningHistoryEntry({
        question: `問題 ${index}`, category: "auto", sourceType: "manual", strategy: "api"
      }, storage);
    }

    const entries = readLearningHistory(storage);
    expect(entries).toHaveLength(LEARNING_HISTORY_MAX_ENTRIES);
    expect(entries[0]?.question).toBe(`問題 ${LEARNING_HISTORY_MAX_ENTRIES + 2}`);
    expect(entries.at(-1)?.question).toBe("問題 3");
  });
});
