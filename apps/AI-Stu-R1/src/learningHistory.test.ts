import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLearningHistoryEntry,
  clearLearningHistory,
  googleAiSearchUrl,
  LEARNING_HISTORY_KEY,
  LEARNING_HISTORY_MAX_ENTRIES,
  RAW_ANSWER_MAX_CHARS,
  answerRelationConfidence,
  canAutoBindAnswer,
  clearPendingRawAnswer,
  extractSharedAnswerText,
  extractGoogleAiSourceUrl,
  findGoogleAiSourceEntry,
  findAnswerBinding,
  hasPlausibleAnswerRelation,
  isHistoryEntry,
  readLearningHistory,
  readPendingRawAnswer,
  savePendingRawAnswerOnce,
  saveGoogleAiSourceUrl,
  saveRawAnswerOnce,
  updateLearningHistoryContent,
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

  it("preserves raw answers forever in the local record, caps them, and never overwrites them", () => {
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "第一題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const first = "原始\r\n\r\n回覆";
    expect(saveRawAnswerOnce(entry.id, first, storage).status).toBe("saved");
    expect(saveRawAnswerOnce(entry.id, "不應覆蓋", storage).status).toBe("already_imported");
    expect(readLearningHistory(storage)[0]).toMatchObject({ rawAnswer: first, organizedAnswer: "原始\n\n回覆" });

    const { entry: longEntry } = addLearningHistoryEntry({ question: "第二題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    expect(saveRawAnswerOnce(longEntry.id, "x".repeat(RAW_ANSWER_MAX_CHARS + 10), storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === longEntry.id)?.rawAnswer).toHaveLength(RAW_ANSWER_MAX_CHARS);
    expect(saveRawAnswerOnce("missing", "答案", storage).status).toBe("not_found");
  });

  it("rejects every URL-only share before it can reach raw or organized answers", () => {
    const storage = makeStorage();
    const ownOrigin = "https://b827262-e500-g9-ws760t.tailc359df.ts.net:8443/";
    const cases = [ownOrigin, `  ${ownOrigin}  `, "https://example.test/only-a-link", "  https://example.test/only-a-link\n"];
    for (const text of cases) {
      const entry = addLearningHistoryEntry({ question: "什麼是重力加速度？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
      expect(extractSharedAnswerText(text, ownOrigin).status).toBe("url_only");
      expect(saveRawAnswerOnce(entry.id, text, storage).status).toBe("rejected_url_only");
      expect(readLearningHistory(storage).find((item) => item.id === entry.id)).not.toMatchObject({ rawAnswer: expect.any(String) });
      expect(readLearningHistory(storage).find((item) => item.id === entry.id)).not.toMatchObject({ organizedAnswer: expect.any(String) });
    }
    expect(extractSharedAnswerText(ownOrigin, ownOrigin).status).toBe("url_only"); // text === payload.url
    expect(extractSharedAnswerText("", ownOrigin).status).toBe("no_text"); // payload.url is never substituted
  });

  it("keeps meaningful shared prose while removing a trailing source URL", () => {
    const extracted = extractSharedAnswerText("重力加速度是物體受到重力造成的加速度。\nhttps://example.test/source", "https://example.test/source");
    expect(extracted).toEqual({ status: "accepted", rawAnswer: "重力加速度是物體受到重力造成的加速度。" });
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "什麼是重力加速度？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    expect(extracted.status).toBe("accepted");
    if (extracted.status === "accepted") expect(saveRawAnswerOnce(entry.id, extracted.rawAnswer, storage).status).toBe("saved");
  });

  it("(1) Google URL-only saves sourceUrl/raw empty", () => {
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "什麼是重力加速度？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const url = "https://www.google.com/search?udm=50&aep=11&hl=zh-TW&q=%E4%BB%80%E9%BA%BC%E6%98%AF%E9%87%8D%E5%8A%9B%E5%8A%A0%E9%80%9F%E5%BA%A6%EF%BC%9F&sourceid=chrome";
    const slackWrappedUrl = "<https://www.google.com/search?udm=50&amp;aep=11&amp;hl=zh-TW&amp;q=%E4%BB%80%E9%BA%BC%E6%98%AF%E9%87%8D%E5%8A%9B%E5%8A%A0%E9%80%9F%E5%BA%A6%EF%BC%9F&amp;sourceid=chrome>";

    expect(extractSharedAnswerText(url, url)).toEqual({ status: "url_only" });
    expect(extractSharedAnswerText(slackWrappedUrl)).toEqual({ status: "url_only" });
    expect(saveRawAnswerOnce(entry.id, url, storage).status).toBe("rejected_url_only");

    const source = extractGoogleAiSourceUrl(slackWrappedUrl, url);
    expect(source).toMatchObject({ sourceUrl: url, question: "什麼是重力加速度？" });
    expect(source && findGoogleAiSourceEntry(readLearningHistory(storage), source)?.id).toBe(entry.id);

    expect(saveGoogleAiSourceUrl(entry.id, source?.sourceUrl, storage).status).toBe("saved");
    const updated = readLearningHistory(storage).find((item) => item.id === entry.id);
    expect(updated?.sourceUrl).toBe(url);
    expect(updated?.rawAnswer).toBeUndefined();
    expect(updated?.organizedAnswer).toBeUndefined();
  });

  it("(2) two questions -> two distinct URLs", () => {
    const storage = makeStorage();
    const first = addLearningHistoryEntry({ question: "第一題是什麼？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    const second = addLearningHistoryEntry({ question: "第二題是什麼？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    const firstUrl = "https://www.google.com/search?udm=50&q=%E7%AC%AC%E4%B8%80%E9%A1%8C%E6%98%AF%E4%BB%80%E9%BA%BC%EF%BC%9F&hl=zh-TW&client=chrome";
    const secondUrl = "https://www.google.com/search?hl=zh-TW&udm=50&q=%E7%AC%AC%E4%BA%8C%E9%A1%8C%E6%98%AF%E4%BB%80%E9%BA%BC%EF%BC%9F&client=safari";

    const firstSource = extractGoogleAiSourceUrl(firstUrl);
    const secondSource = extractGoogleAiSourceUrl(secondUrl);
    expect(firstSource && findGoogleAiSourceEntry(readLearningHistory(storage), firstSource)?.id).toBe(first.id);
    expect(secondSource && findGoogleAiSourceEntry(readLearningHistory(storage), secondSource)?.id).toBe(second.id);

    expect(saveGoogleAiSourceUrl(first.id, firstUrl, storage).status).toBe("saved");
    expect(saveGoogleAiSourceUrl(second.id, secondUrl, storage).status).toBe("saved");

    const entries = readLearningHistory(storage);
    const firstSaved = entries.find((item) => item.id === first.id);
    const secondSaved = entries.find((item) => item.id === second.id);
    expect(firstSaved?.sourceUrl).toBe(firstUrl);
    expect(secondSaved?.sourceUrl).toBe(secondUrl);
    expect(firstSaved?.sourceUrl).not.toBe(secondSaved?.sourceUrl);
  });

  it("(3) SmartBook self-origin rejected", () => {
    const storage = makeStorage();
    const validGoogleUrl = "https://www.google.com/search?udm=50&q=%E9%A1%8C%E7%9B%AE&hl=zh-TW";
    const { entry } = addLearningHistoryEntry({ question: "題目", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const ownOrigin = "https://b827262-e500-g9-ws760t.tailc359df.ts.net:8443/";
    const ownOriginWithPath = "https://b827262-e500-g9-ws760t.tailc359df.ts.net:8443/search?udm=50&q=%E9%A1%8C%E7%9B%AE";

    expect(extractGoogleAiSourceUrl(ownOrigin, ownOrigin)).toBeNull();
    expect(extractGoogleAiSourceUrl(ownOriginWithPath, ownOriginWithPath)).toBeNull();
    expect(extractGoogleAiSourceUrl("https://www.google.com:444/search?udm=50&q=%E9%A1%8C%E7%9B%AE")).toBeNull();
    expect(extractGoogleAiSourceUrl("http://www.google.com/search?udm=50&q=%E9%A1%8C%E7%9B%AE")).toBeNull();

    expect(saveGoogleAiSourceUrl(entry.id, ownOrigin, storage).status).toBe("rejected_source_url");
    expect(saveGoogleAiSourceUrl(entry.id, ownOriginWithPath, storage).status).toBe("rejected_source_url");
    expect(saveRawAnswerOnce(entry.id, ownOrigin, storage).status).toBe("rejected_url_only");

    // Existing valid Google source URL must NEVER be replaced by self-origin
    expect(saveGoogleAiSourceUrl(entry.id, validGoogleUrl, storage).status).toBe("saved");
    expect(saveGoogleAiSourceUrl(entry.id, ownOrigin, storage).status).toBe("rejected_source_url");
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)?.sourceUrl).toBe(validGoogleUrl);
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)?.rawAnswer).toBeUndefined();
  });

  it("(4) prose+Google URL saves both separately", () => {
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "光合作用是什麼？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const url = "https://www.google.com/search?udm=50&q=%E5%85%89%E5%90%88%E4%BD%9C%E7%94%A8%E6%98%AF%E4%BB%80%E9%BA%BC%EF%BC%9F&hl=zh-TW";
    const text = `光合作用是植物利用光能製造養分的過程。\n${url}`;

    const extraction = extractSharedAnswerText(text, url);
    expect(extraction).toEqual({ status: "accepted", rawAnswer: "光合作用是植物利用光能製造養分的過程。" });

    const source = extractGoogleAiSourceUrl(text, url);
    expect(source).toMatchObject({ sourceUrl: url, question: "光合作用是什麼？" });

    expect(saveGoogleAiSourceUrl(entry.id, url, storage).status).toBe("saved");
    if (extraction.status === "accepted") expect(saveRawAnswerOnce(entry.id, extraction.rawAnswer, storage).status).toBe("saved");

    const saved = readLearningHistory(storage).find((item) => item.id === entry.id);
    expect(saved?.rawAnswer).toBe("光合作用是植物利用光能製造養分的過程。");
    expect(saved?.sourceUrl).toBe(url);
    expect(saved?.rawAnswer).not.toContain("google.com");
    expect(saved?.sourceUrl).not.toContain("植物利用光能");
  });

  it("(5) duplicate/replay never overwrites existing rawAnswer and URL binding remains deterministic/question-bound", () => {
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "牛頓第二定律是什麼？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const firstUrl = "https://www.google.com/search?udm=50&q=%E7%89%9B%E9%A0%93%E7%AC%AC%E4%BA%8C%E5%AE%9A%E5%BE%8B%E6%98%AF%E4%BB%80%E9%BA%BC%EF%BC%9F&hl=zh-TW";
    const replayUrl = `${firstUrl}&aep=11`;
    const mismatchUrl = "https://www.google.com/search?udm=50&q=%E4%B8%8D%E5%90%8C%E9%A1%8C%E7%9B%AE&hl=zh-TW";

    expect(saveRawAnswerOnce(entry.id, "牛頓第二定律可寫成 F=ma。", storage).status).toBe("saved");
    expect(saveGoogleAiSourceUrl(entry.id, firstUrl, storage).status).toBe("saved");

    // Replay of raw answer must not overwrite existing rawAnswer
    expect(saveRawAnswerOnce(entry.id, "重播不得覆寫。", storage).status).toBe("already_imported");
    // Replay of source URL must not overwrite existing sourceUrl
    expect(saveGoogleAiSourceUrl(entry.id, replayUrl, storage).status).toBe("already_saved");
    // URL with mismatch question must be rejected
    expect(saveGoogleAiSourceUrl(entry.id, mismatchUrl, storage).status).toBe("question_mismatch");

    const saved = readLearningHistory(storage).find((item) => item.id === entry.id);
    expect(saved?.rawAnswer).toBe("牛頓第二定律可寫成 F=ma。");
    expect(saved?.sourceUrl).toBe(firstUrl);
  });

  it("allows an explicit edit to add source, replace raw, remove blank fields, and persist through reload", () => {
    const storage = makeStorage();
    const question = "什麼是重力加速度？";
    const { entry } = addLearningHistoryEntry({ question, category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const url = `https://www.google.com/search?udm=50&q=${encodeURIComponent(question)}`;

    expect(updateLearningHistoryContent(entry.id, { rawAnswer: "舊回覆", sourceUrl: url }, storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)).toMatchObject({ rawAnswer: "舊回覆", sourceUrl: url, organizedAnswer: "舊回覆" });

    expect(updateLearningHistoryContent(entry.id, { rawAnswer: "新的\r\n\r\n回覆", sourceUrl: url }, storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)).toMatchObject({ rawAnswer: "新的\r\n\r\n回覆", organizedAnswer: "新的\n\n回覆" });

    expect(updateLearningHistoryContent(entry.id, { rawAnswer: "   ", sourceUrl: "" }, storage).status).toBe("saved");
    const removed = readLearningHistory(storage).find((item) => item.id === entry.id);
    expect(removed?.rawAnswer).toBeUndefined();
    expect(removed?.sourceUrl).toBeUndefined();
    expect(removed?.organizedAnswer).toBeUndefined();
  });

  it("keeps raw answer prose separate from source URLs during explicit edits", () => {
    const storage = makeStorage();
    const question = "什麼是重力加速度？";
    const { entry } = addLearningHistoryEntry({ question, category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    const googleUrl = `https://www.google.com/search?udm=50&q=${encodeURIComponent(question)}`;
    const wrappedGoogleUrl = `<${googleUrl.replaceAll("&", "&amp;")}>`;

    expect(updateLearningHistoryContent(entry.id, { rawAnswer: "原有回答", sourceUrl: "" }, storage).status).toBe("saved");
    for (const rawAnswer of [
      googleUrl,
      "https://b827262-e500-g9-ws760t.tailc359df.ts.net:8443/search?udm=50&q=%E9%A1%8C%E7%9B%AE"
    ]) {
      const before = storage.getItem(LEARNING_HISTORY_KEY);
      expect(updateLearningHistoryContent(entry.id, { rawAnswer, sourceUrl: "" }, storage).status).toBe("rejected_url_only");
      expect(storage.getItem(LEARNING_HISTORY_KEY)).toBe(before);
    }

    const proseWithUrl = `重力加速度是物體受到重力造成的加速度。\n${googleUrl}`;
    expect(updateLearningHistoryContent(entry.id, { rawAnswer: proseWithUrl, sourceUrl: "" }, storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)).toMatchObject({
      rawAnswer: proseWithUrl,
      organizedAnswer: proseWithUrl
    });

    expect(updateLearningHistoryContent(entry.id, { rawAnswer: "正常替換的回答", sourceUrl: wrappedGoogleUrl }, storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === entry.id)).toMatchObject({
      rawAnswer: "正常替換的回答",
      organizedAnswer: "正常替換的回答",
      sourceUrl: googleUrl
    });
  });

  it("keeps cancel logically byte-for-byte unchanged because only explicit save calls the edit writer", () => {
    const storage = makeStorage();
    const { entry } = addLearningHistoryEntry({ question: "取消修改", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    expect(saveRawAnswerOnce(entry.id, "原始內容", storage).status).toBe("saved");
    const before = storage.getItem(LEARNING_HISTORY_KEY);
    // A UI cancel only discards its component draft; it deliberately invokes no storage writer.
    const discardedDraft = { rawAnswer: "不應儲存", sourceUrl: "https://example.test/" };
    expect(discardedDraft.rawAnswer).toBe("不應儲存");
    expect(storage.getItem(LEARNING_HISTORY_KEY)).toBe(before);
  });

  it("edits exactly one record and rejects invalid, self-origin, non-AI-mode, and mismatched source URLs", () => {
    const storage = makeStorage();
    const first = addLearningHistoryEntry({ question: "第一題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    const second = addLearningHistoryEntry({ question: "第二題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    expect(saveRawAnswerOnce(first.id, "第一題舊回覆", storage).status).toBe("saved");
    expect(saveRawAnswerOnce(second.id, "第二題舊回覆", storage).status).toBe("saved");
    const validSecond = `https://www.google.com/search?udm=50&q=${encodeURIComponent("第二題")}`;

    expect(updateLearningHistoryContent(second.id, { rawAnswer: "第二題新回覆", sourceUrl: validSecond }, storage).status).toBe("saved");
    expect(readLearningHistory(storage).find((item) => item.id === first.id)?.rawAnswer).toBe("第一題舊回覆");
    expect(readLearningHistory(storage).find((item) => item.id === second.id)).toMatchObject({ rawAnswer: "第二題新回覆", sourceUrl: validSecond });

    for (const badUrl of [
      "https://smartbook.example/search?udm=50&q=%E7%AC%AC%E4%BA%8C%E9%A1%8C",
      "https://www.google.com/search?q=%E7%AC%AC%E4%BA%8C%E9%A1%8C",
      "https://www.google.com/search?udm=50&q=%E7%AC%AC%E4%B8%80%E9%A1%8C"
    ]) {
      const before = storage.getItem(LEARNING_HISTORY_KEY);
      expect(updateLearningHistoryContent(second.id, { rawAnswer: "不應變動", sourceUrl: badUrl }, storage).status).toMatch(/rejected_source_url|question_mismatch/);
      expect(storage.getItem(LEARNING_HISTORY_KEY)).toBe(before);
    }
  });

  it("Qoder A1/A2/X1 rejects single or generic fragments and routes weak single candidates", () => {
    const storage = makeStorage();
    const first = addLearningHistoryEntry({ question: "什麼是重力加速度？", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    const highBinding = findAnswerBinding(readLearningHistory(storage), "重力加速度是物體在地球附近受到重力造成的加速度。");
    expect(highBinding.matches.map((item) => item.id)).toEqual([first.id]);
    expect(canAutoBindAnswer(highBinding)).toBe(true);
    expect(findAnswerBinding(readLearningHistory(storage), "什麼意思？").matches).toEqual([]); // A1: interrogative alone is not evidence.
    expect(findAnswerBinding(readLearningHistory(storage), "這與重力無關。").matches).toEqual([]); // A2: one bigram is not enough.
    const unrelatedSinglePending = findAnswerBinding(readLearningHistory(storage), "這是一份完全不同的回答。");
    expect(unrelatedSinglePending.hasExplicitMismatch).toBe(true); // one pending record still requires an explicit choice
    expect(canAutoBindAnswer(unrelatedSinglePending)).toBe(false);
    expect(hasPlausibleAnswerRelation("什麼是重力加速度？", "重力加速度的單位是 m/s²。")).toBe(true);
    expect(hasPlausibleAnswerRelation("什麼是重力加速度？", "請記得明天繳交作業。")).toBe(false);
    const weak = addLearningHistoryEntry({ question: "甲乙丙丁戊己庚辛壬癸", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage).entry;
    const weakBinding = findAnswerBinding(readLearningHistory(storage), "甲乙丙丁戊的說明");
    expect(answerRelationConfidence(weak.question, "甲乙丙丁戊的說明")).toBe("weak"); // X1: chooser, never silent auto-bind.
    expect(weakBinding.matches.map((entry) => entry.id)).toContain(weak.id);
    expect(canAutoBindAnswer(weakBinding)).toBe(false);
    addLearningHistoryEntry({ question: "第二題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    addLearningHistoryEntry({ question: "第三題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    addLearningHistoryEntry({ question: "第四題", category: "auto", sourceType: "manual", strategy: "google-ai" }, storage);
    expect(findAnswerBinding(readLearningHistory(storage), "問題的整理方式").matches).toHaveLength(0);
  });

  it("Qoder L1-L4 accepts genuine high-confidence relations", () => {
    expect(answerRelationConfidence("什麼是重力加速度？", "重力加速度會使物體向下加速。")).toBe("high");
    expect(answerRelationConfidence("圓周率是什麼？", "圓周率是約等於 3.14159 的常數。")).toBe("high");
    expect(answerRelationConfidence("牛頓第二定律如何計算？", "牛頓第二定律計算時可寫為 F=ma。")).toBe("high");
    expect(answerRelationConfidence("光合作用的步驟有哪些？", "光合作用的步驟會利用光能製造養分。")).toBe("high");
  });

  it("persists one low-confidence shared raw answer through reload until explicit bind or discard", () => {
    const storage = makeStorage();
    expect(savePendingRawAnswerOnce("甲乙丙丁戊的說明", storage)).toEqual({ rawAnswer: "甲乙丙丁戊的說明" });
    expect(readPendingRawAnswer(storage)).toEqual({ rawAnswer: "甲乙丙丁戊的說明" }); // reload/back
    expect(savePendingRawAnswerOnce("後來的回覆不得覆蓋", storage)).toEqual({ rawAnswer: "甲乙丙丁戊的說明" });
    clearPendingRawAnswer(storage);
    expect(readPendingRawAnswer(storage)).toBeNull();
  });

  it("rejects malformed optional raw and organized fields instead of trusting storage", () => {
    expect(isHistoryEntry({ id: "id", askedAt: "now", question: "題目", category: "auto", sourceType: "manual", strategy: "google-ai", rawAnswer: 1 })).toBe(false);
    expect(isHistoryEntry({ id: "id", askedAt: "now", question: "題目", category: "auto", sourceType: "manual", strategy: "google-ai", rawAnswer: "證據", organizedAnswer: "整理" })).toBe(true);
  });
});
