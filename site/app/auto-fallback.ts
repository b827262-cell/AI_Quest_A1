/** D-06 Auto fallback: local validation and a single, direct Google AI Mode handoff. */

import { HANT_MAP, SIMPLIFIED_ONLY } from "./hant-set";
import { HANT_PHRASES, HANT_PHRASE_MAX } from "./hant-phrases";

export type LocalAnswerVerdict =
  | { status: "VALID"; answer: string }
  | { status: "INVALID"; answer: string; reason: string };

const SIMPLIFIED_SET = new Set(SIMPLIFIED_ONLY);
// hasUnresolvedSimplified is defence in depth: normalizeToHant rewrites exactly
// the SIMPLIFIED_ONLY set, so a VALID answer must never contain one. The check
// stays so a future table desync fails closed instead of serving residue.


// Domain and phrase-level mappings that take precedence over character-level conversion.
// This resolves words like 规划 -> 規劃, 经营 -> 經營 where individual characters
// (e.g. 划) might be ambiguous in Big5, but unambiguous within the specific phrase.
const CORE_PHRASES: Record<string, string> = {
  "经营": "經營",
  "企业": "企業",
  "长期": "長期",
  "规划": "規劃",
  "电脑": "電腦",
  "软体": "軟體",
  "软件": "軟體",
  "网络": "網路",
  "结构": "結構",
  "一种": "一種",
  "计算": "計算",
  "设备": "設備",
  "程式设计": "程式設計",
  "数据结构": "資料結構",
  "资料结构": "資料結構",
  "产业升级": "產業升級",
};

export function normalizeToHant(text: string): { text: string; changed: number } {
  const src = String(text ?? "");
  let changed = 0;
  const maxLen = Math.max(HANT_PHRASE_MAX, 6);
  let out = "";
  let i = 0;
  while (i < src.length) {
    let matched: string | null = null;
    const upper = Math.min(maxLen, src.length - i);
    for (let n = upper; n >= 2; n -= 1) {
      const key = src.slice(i, i + n);
      const rep = (CORE_PHRASES as Record<string, string>)[key] ?? (HANT_PHRASES as Record<string, string>)[key];
      if (rep !== undefined && rep !== key) {
        matched = rep;
        changed += n;
        i += n;
        break;
      }
    }
    if (matched !== null) {
      out += matched;
      continue;
    }
    const ch = src[i];
    const mapped = (HANT_MAP as Record<string, string>)[ch];
    if (mapped !== undefined && mapped !== ch) {
      out += mapped;
      changed += 1;
    } else {
      out += ch;
    }
    i += 1;
  }
  return { text: out, changed };
}

export function postprocessTraditionalChinese(input: string): string {
  const cleaned = String(input ?? "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
  return normalizeToHant(cleaned).text.trim();
}

const NUMERIC_ANSWER_RE = /^[\s\d.,:%+\-=/×÷()（）]+$/u;

export function isNumericAnswer(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 0 && NUMERIC_ANSWER_RE.test(trimmed);
}

const HAN_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

export function isQuestionEcho(question: string, answer: string): boolean {
  const cjk = (s: string) => [...(String(s).match(HAN_RE_G) || [])];
  const trimmed = String(answer ?? "").trim();
  if (trimmed.length === 0) return true;
  const a = cjk(trimmed);
  const q = cjk(question);
  // D7: non-CJK answers (e.g. numeric "13", "5") are not echoes merely
  // because there is no CJK overlap. Only a verbatim restatement of the question counts.
  if (a.length === 0) {
    const flatQ = String(question ?? "").trim().replace(/\s+/g, "");
    return flatQ.length > 0 && trimmed.replace(/\s+/g, "") === flatQ;
  }
  if (q.length === 0) return false;
  const qset = new Set(q);
  const overlap = a.filter((c) => qset.has(c)).length;
  return overlap / a.length >= 0.8 && a.length <= q.length + 4;
}

const INSTRUCTION_MARKERS = [
  "請用繁體中文清楚",
  "約 150 字以內",
  "切勿重複相同句子",
  "直接回答以下學習問題",
];

export function isInstructionEcho(answer: string): boolean {
  return INSTRUCTION_MARKERS.some((m) => String(answer).includes(m));
}

export function hasRepetitionLoop(text: string): boolean {
  const len = text.length;
  for (let unit = 1; unit <= Math.min(32, Math.floor(len / 3)); unit += 1) {
    const requiredCopies = unit === 1 ? 8 : unit < 8 ? 4 : 3;
    if (len < unit * requiredCopies) continue;
    const tail = text.slice(len - unit);
    let copies = 1;
    let pos = len - unit;
    while (pos - unit >= 0 && text.slice(pos - unit, pos) === tail) {
      copies += 1;
      pos -= unit;
    }
    if (copies >= requiredCopies) return true;
  }
  return false;
}

export function hasUnresolvedSimplified(text: string): boolean {
  for (const ch of text) {
    if (SIMPLIFIED_SET.has(ch)) return true;
  }
  return false;
}

export function validateLocalAnswer(question: string, rawAnswer: string): LocalAnswerVerdict {
  const answer = postprocessTraditionalChinese(rawAnswer);
  if (!answer) return { status: "INVALID", answer, reason: "empty-answer" };

  const minChars = isNumericAnswer(answer) ? 1 : 2;
  if (answer.length < minChars) return { status: "INVALID", answer, reason: "too-short" };

  if (isInstructionEcho(answer)) return { status: "INVALID", answer, reason: "instruction-echo" };
  if (isQuestionEcho(question, answer)) return { status: "INVALID", answer, reason: "question-echo" };
  if (hasRepetitionLoop(answer)) return { status: "INVALID", answer, reason: "repetition-loop" };
  if (hasUnresolvedSimplified(answer)) return { status: "INVALID", answer, reason: "unresolved-simplified" };

  return { status: "VALID", answer };
}

/** The product's canonical Google AI Mode URL builder. Never fetches Google. */
export function buildGoogleAiModeUrl(question: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(question)}&udm=50&aep=11&hl=zh-TW`;
}

export type AutoFallbackState = "IDLE" | "GENERATING" | "GOOGLE_NAVIGATING" | "DONE" | "CANCELLED";

/** One submission may hand off once only; cancelled/returned flows are terminal. */
export function createAutoFallbackGuard() {
  let state: AutoFallbackState = "IDLE";
  return {
    get state() { return state; },
    begin() { if (state !== "IDLE") return false; state = "GENERATING"; return true; },
    navigateOnce() { if (state !== "GENERATING") return false; state = "GOOGLE_NAVIGATING"; return true; },
    done() { if (state === "GENERATING") state = "DONE"; },
    cancel() { state = "CANCELLED"; },
  };
}
