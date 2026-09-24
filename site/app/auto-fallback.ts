/** D-06 Auto fallback: local validation and a single, direct Google AI Mode handoff. */

import { HANT_MAP, SIMPLIFIED_ONLY } from "./hant-set";
import { HANT_PHRASES, HANT_PHRASE_MAX } from "./hant-phrases";

export type LocalAnswerVerdict =
  | { status: "VALID"; answer: string }
  | { status: "INVALID"; answer: string; reason: string };

/**
 * `hant-set.ts` classifies a character as `ambiguous` (Big5-legal) whenever ANY
 * traditional usage exists, and then neither rewrites nor rejects it. That is
 * correct for 里/后/台 but wrong for 机/并/优: their only surviving modern
 * reading is the Simplified one, so every unconverted occurrence is residue
 * that used to be served as VALID. This table rewrites those 21 characters and
 * `SIMPLIFIED_SET` below fails closed on them, so a future table desync
 * downgrades the answer instead of leaking it. The generated file stays
 * untouched - it is owned by fixtures/gen-hant-set.py.
 */
const RESIDUE_CHAR_MAP: Record<string, string> = {
  机: "機",
  并: "並",
  优: "優",
  怀: "懷",
  据: "據",
  极: "極",
  构: "構",
  洁: "潔",
  种: "種",
  胜: "勝",
  触: "觸",
  圣: "聖",
  坏: "壞",
  惊: "驚",
  气: "氣",
  虫: "蟲",
  适: "適",
  价: "價",
  异: "異",
  着: "著",
  愿: "願",
};

const SIMPLIFIED_SET = new Set<string>([...SIMPLIFIED_ONLY, ...Object.keys(RESIDUE_CHAR_MAP)]);
// hasUnresolvedSimplified is defence in depth: normalizeToHant rewrites exactly
// SIMPLIFIED_ONLY plus RESIDUE_CHAR_MAP, so a VALID answer must never contain
// one. The check stays so a future table desync fails closed instead of serving
// residue.
//
// Exported read-only view of the curated half of that promise so the Gate B
// invariant test can assert both directions: every character here is converted
// by `normalizeToHant`, and rejected by `hasUnresolvedSimplified` if it ever
// survives.
export const RESIDUE_OVERRIDE_CHARS: readonly string[] = Object.keys(RESIDUE_CHAR_MAP);

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
  // Qwen zh-Hant audit (2026-09-22) 6a: Taiwan-usage overrides for entries the
  // auto-generated table (Big5/OpenCC criterion) got wrong for TW readers.
  // CORE_PHRASES takes precedence over HANT_PHRASES, so these are the minimal fix.
  "数据": "資料",
  "变量": "變數",
  "这里": "這裡",
  "递回": "遞回",
  "面积": "面積",
  "长和面": "長和面",
  // D-07 residue fix (blocker 2). These characters are Big5-legal, so the
  // generated table refuses to touch them, yet in modern zh-TW prose the
  // Simplified reading is the only live one *in these words*. Listing the words
  // - never the bare character - is what keeps a surname such as 于右任 or
  // 范仲淹 out of reach: no phrase here matches a name-initial 于/范.
  "于是": "於是", "由于": "由於", "位于": "位於", "属于": "屬於", "关于": "關於",
  "对于": "對於", "用于": "用於", "处于": "處於", "低于": "低於", "高于": "高於",
  "等于": "等於", "大于": "大於", "小于": "小於", "至于": "至於", "易于": "易於",
  "善于": "善於", "便于": "便於", "利于": "利於", "鉴于": "鑑於", "限于": "限於",
  "归于": "歸於", "出于": "出於", "助于": "助於", "在于": "在於", "基于": "基於",
  "急于": "急於", "得益于": "得益於", "有害于": "有害於",
  "有助于": "有助於", "着眼于": "著眼於",
  "范围": "範圍", "规范": "規範", "示范": "示範", "范例": "範例", "范本": "範本",
  "范畴": "範疇", "防范": "防範", "模范": "模範",
  "以后": "以後", "然后": "然後", "最后": "最後", "之后": "之後", "此后": "此後",
  "随后": "隨後", "而后": "而後", "事后": "事後", "背后": "背後", "前后": "前後",
  "后来": "後來", "后面": "後面", "后者": "後者", "后天": "後天", "后悔": "後悔",
  "午后": "午後", "后期": "後期",
  "其余": "其餘", "剩余": "剩餘", "盈余": "盈餘", "业余": "業餘", "余数": "餘數",
  "节余": "節餘", "余裕": "餘裕", "余下": "餘下",
  "那里": "那裡", "哪里": "哪裡", "里面": "裡面", "心里": "心裡", "手里": "手裡",
  "家里": "家裡", "夜里": "夜裡",
  "几个": "幾個", "几天": "幾天", "几乎": "幾乎", "几种": "幾種", "几十": "幾十",
  "几点": "幾點", "几位": "幾位", "几次": "幾次", "几何": "幾何", "几时": "幾時",
  "几近": "幾近",
  "恢复": "恢復", "复杂": "複雜", "重复": "重複", "反复": "反覆", "复制": "複製",
  "复兴": "復興", "复活": "復活", "复原": "復原", "复数": "複數", "复利": "複利",
  "复习": "複習",
  "标准": "標準", "准则": "準則", "准时": "準時", "水准": "水準", "瞄准": "瞄準",
  "采用": "採用", "采取": "採取", "采购": "採購", "采访": "採訪", "采集": "採集",
  "采样": "採樣", "开采": "開採", "采纳": "採納",
  "特征": "特徵", "象征": "象徵", "征兆": "徵兆",
  // 划 is Big5-legal (划算 stays 划算), so the residue is fixed per word. TW
  // official usage is 計畫/企劃 (same 6a precedence rule as 数据 → 資料);
  // leaving 計划 would serve a mixed-form word as VALID.
  "计划": "計畫", "企划": "企劃", "策划": "策劃", "筹划": "籌劃", "划分": "劃分", "划拨": "劃撥",
  "伙伴": "夥伴", "合伙": "合夥", "同伙": "同夥",
};

export function normalizeToHant(text: string): { text: string; changed: number } {
  const src = String(text ?? "");
  let changed = 0;
  // CORE_PHRASES are curated Taiwan-usage/domain terms (incl. Qwen zh-Hant
  // audit 6a overrides). They take precedence over the auto-generated
  // HANT_PHRASES table even where a longer contextual HANT_PHRASES entry would
  // otherwise shadow them (e.g. 供数据 vs 数据, 变量 `x` vs 变量). We therefore
  // pre-scan CORE phrase spans and let them carve the text into protected
  // segments; the auto table and char map only fill the gaps.
  const coreKeys = Object.keys(CORE_PHRASES).filter((k) => k !== "" && k !== (CORE_PHRASES as Record<string, string>)[k]);
  const maxCoreLen = coreKeys.reduce((m, k) => Math.max(m, [...k].length), 0);
  const spans: Array<{ start: number; end: number; rep: string }> = [];
  let si = 0;
  outer: while (si < src.length) {
    const upper = Math.min(maxCoreLen, src.length - si);
    for (let n = upper; n >= 1; n -= 1) {
      // Span matching is by UTF-16 code units; all CORE keys are BMP-only.
      const key = src.slice(si, si + n);
      const rep = (CORE_PHRASES as Record<string, string>)[key];
      if (rep !== undefined && rep !== key) {
        spans.push({ start: si, end: si + n, rep });
        si += n;
        continue outer;
      }
    }
    si += 1;
  }
  const spanAt = new Map<number, { end: number; rep: string }>();
  for (const s of spans) spanAt.set(s.start, s);
  const nextCoreStart = (from: number): number => {
    for (const s of spans) if (s.start >= from) return s.start;
    return src.length;
  };

  let out = "";
  let i = 0;
  const maxLen = Math.max(HANT_PHRASE_MAX, 6);
  while (i < src.length) {
    const core = spanAt.get(i);
    if (core) {
      out += core.rep;
      changed += core.end - i;
      i = core.end;
      continue;
    }
    const limit = nextCoreStart(i); // an auto-table match must not cross a CORE span
    let matched: string | null = null;
    const upper = Math.min(maxLen, limit - i, src.length - i);
    for (let n = upper; n >= 2; n -= 1) {
      const key = src.slice(i, i + n);
      const rep = (HANT_PHRASES as Record<string, string>)[key];
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
    // The curated overrides win over the generated map so a later regeneration
    // of hant-set.ts can silently narrow `ambiguous` without re-opening the
    // residue hole this closes.
    const mapped = (RESIDUE_CHAR_MAP as Record<string, string>)[ch] ?? (HANT_MAP as Record<string, string>)[ch];
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

/**
 * `于` and `范` are the residue characters that are ALSO live Traditional
 * surnames, so neither a blanket rewrite nor a blanket rejection is acceptable.
 * Every compound/prepositional use is rewritten by CORE_PHRASES above; a bare
 * one that survives is residue unless it sits where a surname sits - start of
 * the answer, after non-Han text, or after an appellation. That is what keeps
 * 「阿里山位于…」 caught while 「于右任是近代書法家。」 stays a VALID answer.
 * The list is written in converted form because the detector sees post-process
 * output (a source 員 would already have been rewritten by the time we look).
 */
const CONTEXTUAL_RESIDUE = new Set(["于", "范"]);
const SURNAME_INTRODUCERS = [
  "是", "姓", "氏", "的", "與", "和", "及", "如", "家", "人", "師", "員",
  "教授", "先生", "女士", "小姐", "博士", "老師", "院士", "校長", "主任",
  "醫師", "作家", "畫家", "書法家", "詩人", "同志", "巨匠", "大師",
];

function isSurnamePosition(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(prev)) return true;
  const before = chars.slice(0, index).join("");
  return SURNAME_INTRODUCERS.some((token) => before.endsWith(token));
}

export function hasUnresolvedSimplified(text: string): boolean {
  const chars = [...String(text ?? "")];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (SIMPLIFIED_SET.has(ch)) return true;
    if (CONTEXTUAL_RESIDUE.has(ch) && !isSurnamePosition(chars, i)) return true;
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

/**
 * Learner-facing cause for the per-question Google consent dialog. The reason
 * tokens are validator/abort labels, never copy: an unknown token must still
 * produce a sentence, so the lookup degrades to the generic wording instead of
 * printing `undefined` inside the consent text.
 */
const HANDOFF_REASON_LABELS: Record<string, string> = {
  "empty-answer": "模型沒有產生可顯示的內容",
  "too-short": "回答過短，無法確認有效",
  "instruction-echo": "回答只有重複提示文字",
  "question-echo": "回答只有重複你的問題",
  "repetition-loop": "回答出現重複迴圈",
  "unresolved-simplified": "回答仍有未轉換的簡體殘字",
  timeout: "本機模型逾時未回應",
  "local-error": "本機模型發生錯誤",
  "stalled-download": "模型下載停滯",
};

export function handoffReasonLabel(reason?: string): string {
  return (reason && HANDOFF_REASON_LABELS[reason]) || "本機模型無法完成這一道題";
}

/** A consented handoff either opened one tab, was blocked, or was a repeat. */
export type ConsentHandoffOutcome = "opened" | "blocked" | "duplicate";

export type ConsentHandoffWindow = {
  open(url: string, target: string, features?: string): { opener: unknown } | null;
};

/**
 * Owner contract (D-07 Gate-D): pressing 「同意並在新分頁開啟 Google AI」 opens
 * exactly ONE new tab and leaves the student page where it is — a same-tab
 * navigation evicts the question, the triage result and any in-flight model
 * work. The one-shot guard turns a double click into a no-op instead of a second
 * tab, and a blocked popup degrades to a visible manual link rather than a
 * navigation. Nothing is ever (re)submitted from here.
 *
 * `window.open` is deliberately called without a features string: passing
 * `noopener` makes the call return null even when the tab did open, which would
 * destroy the popup-blocked signal. The opener reference is severed directly.
 */
export function openConsentHandoffTab(
  url: string,
  guard: { begin(): boolean; navigateOnce(): boolean },
  win: ConsentHandoffWindow | null | undefined,
): ConsentHandoffOutcome {
  // The guard instance IS the single-tab budget: the first press walks
  // IDLE → GENERATING → GOOGLE_NAVIGATING, and every later press on that same
  // guard is rejected before `window.open` is ever reached.
  if (!guard.begin() || !guard.navigateOnce()) return "duplicate";
  let opened: { opener: unknown } | null = null;
  try {
    opened = win?.open(url, "_blank") ?? null;
  } catch {
    opened = null;
  }
  if (!opened) return "blocked";
  opened.opener = null;
  return "opened";
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
