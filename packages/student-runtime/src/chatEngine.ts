import type { BookContent } from "@ai-smartbook/schema";

export interface ChatEngineResult {
  answer: string;
  matchedContentIds: string[];
}

/**
 * Keyword chat engine used in 1GB sqlite-api mode. It performs simple token
 * overlap retrieval over book contents and composes an extractive answer.
 * No external AI service is contacted.
 */
/**
 * Build search tokens from a query. Latin words stay whole; CJK text is
 * expanded into character bigrams so retrieval works without word spacing.
 */
function tokenizeQuery(question: string): string[] {
  const grams = new Set<string>();
  for (const w of question.split(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/)) {
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && /[a-z0-9]/.test(t)) grams.add(t);
  }
  const cleaned = question.replace(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/g, "").toLowerCase();
  if (cleaned.length === 1) {
    grams.add(cleaned);
  } else {
    for (let i = 0; i < cleaned.length - 1; i++) {
      grams.add(cleaned.slice(i, i + 2));
    }
  }
  return [...grams];
}

export function keywordChat(question: string, contents: BookContent[]): ChatEngineResult {
  const tokens = tokenizeQuery(question);

  if (tokens.length === 0 || contents.length === 0) {
    return { answer: "目前書本內容中沒有找到明確答案，請換個關鍵字再試一次。", matchedContentIds: [] };
  }

  const scored = contents
    .map((c) => {
      const text = c.contentText.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    return { answer: "目前書本內容中沒有找到明確答案，請換個關鍵字再試一次。", matchedContentIds: [] };
  }

  const passages = scored.map((s) => s.c.contentText);
  const answer = [
    "根據書本內容，找到以下相關段落：",
    ...passages.map((p, i) => `${i + 1}. ${p}`)
  ].join("\n");

  return { answer, matchedContentIds: scored.map((s) => s.c.id) };
}
