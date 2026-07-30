/**
 * Lightweight answer completeness checks.
 *
 * This is intentionally conservative: it identifies strong truncation signals
 * and reports them to the caller, but it does not reject ordinary short answers
 * just because they are short or do not end in a full stop.
 */

export type AnswerCompletenessReason =
  | "finish_reason_length"
  | "stream_not_ended"
  | "answer_truncated"
  | "dangling_punctuation"
  | "unclosed_code_fence"
  | "missing_requested_items";

export type AnswerCompleteness = {
  complete: boolean;
  reasons: AnswerCompletenessReason[];
  requestedItems: string[];
  coveredItems: string[];
};

type RequestedItem = { label: string; aliases: string[] };

const KNOWN_ITEM_ALIASES: RequestedItem[] = [
  { label: "泡沫排序", aliases: ["泡沫排序", "冒泡排序", "bubble sort", "bubblesort"] },
  { label: "插入排序", aliases: ["插入排序", "insertion sort", "insertionsort"] },
  { label: "合併排序", aliases: ["合併排序", "归并排序", "merge sort", "mergesort"] },
  { label: "快速排序", aliases: ["快速排序", "quicksort", "quick sort"] },
  { label: "選擇排序", aliases: ["選擇排序", "选择排序", "selection sort", "selectionsort"] },
  { label: "堆積排序", aliases: ["堆積排序", "堆排序", "heap sort", "heapsort"] }
];

function normalizeForMatch(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s`*_#()\[\]{}:：,，。.!！？?;；、|>\-_/]/g, "");
}

function findKnownItems(question: string): RequestedItem[] {
  const normalizedQuestion = normalizeForMatch(question);
  return KNOWN_ITEM_ALIASES.filter((item) =>
    item.aliases.some((alias) => normalizedQuestion.includes(normalizeForMatch(alias)))
  );
}

function findNumberedItems(question: string): RequestedItem[] {
  const items: RequestedItem[] = [];
  const seen = new Set<string>();
  const numbered = /^\s*(?:[-*+]|\d+[.)、:：])\s*(.+?)\s*$/gm;
  for (const match of question.matchAll(numbered)) {
    const label = match[1]?.trim();
    if (!label || label.length > 120) continue;
    const known = KNOWN_ITEM_ALIASES.find((item) =>
      item.aliases.some((alias) => normalizeForMatch(label).includes(normalizeForMatch(alias)))
    );
    const key = normalizeForMatch(known?.label ?? label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(known ?? { label, aliases: [label] });
  }
  return items;
}

function requestedItems(question: string): RequestedItem[] {
  const numbered = findNumberedItems(question);
  const known = findKnownItems(question);
  const merged = [...numbered];
  const seen = new Set(merged.map((item) => normalizeForMatch(item.label)));
  for (const item of known) {
    const key = normalizeForMatch(item.label);
    if (!seen.has(key)) {
      merged.push(item);
      seen.add(key);
    }
  }
  return merged;
}

function covers(answer: string, item: RequestedItem): boolean {
  const normalizedAnswer = normalizeForMatch(answer);
  return item.aliases.some((alias) => normalizedAnswer.includes(normalizeForMatch(alias)));
}

function hasDanglingEnding(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return true;
  if (/(?:[:：,，;；、]|[-*+]\s*)$/.test(trimmed)) return true;
  return /(?:^|\n)\s*(?:\d+[.)、]|[-*+])\s*$/.test(trimmed);
}

function hasUnclosedCodeFence(answer: string): boolean {
  const fences = answer.match(/```/g);
  return Boolean(fences && fences.length % 2 === 1);
}

export function assessAnswerCompleteness(
  question: string,
  answer: string,
  options: {
    finishReason?: string;
    streamEndedNormally?: boolean;
    answerTruncated?: boolean;
  } = {}
): AnswerCompleteness {
  const reasons: AnswerCompletenessReason[] = [];
  const finishReason = options.finishReason?.trim().toLowerCase();
  if (finishReason === "length" || finishReason === "max_tokens" || finishReason === "token_limit") {
    reasons.push("finish_reason_length");
  }
  if (options.streamEndedNormally === false) reasons.push("stream_not_ended");
  if (options.answerTruncated) reasons.push("answer_truncated");
  if (hasUnclosedCodeFence(answer)) reasons.push("unclosed_code_fence");

  const items = requestedItems(question);
  const covered = items.filter((item) => covers(answer, item));
  // A dangling colon/list marker is useful diagnostic evidence, but alone it
  // must not block an otherwise normal short answer.
  if (answer.trim().length >= 120 && hasDanglingEnding(answer)) {
    reasons.push("dangling_punctuation");
  }
  if (items.length >= 2 && covered.length < items.length) {
    reasons.push("missing_requested_items");
  }

  return {
    complete: reasons.length === 0,
    reasons,
    requestedItems: items.map((item) => item.label),
    coveredItems: covered.map((item) => item.label)
  };
}
