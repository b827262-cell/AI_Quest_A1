/** D-06 Auto fallback: local validation and a single, direct Google AI Mode handoff. */

export type LocalAnswerVerdict =
  | { status: "VALID"; answer: string }
  | { status: "INVALID"; answer: string; reason: string };

// These are Simplified-only characters which commonly escape a zh-Hant prompt.
// We first convert the deterministic, unambiguous forms below; anything left is
// rejected instead of pretending it is Traditional Chinese.
const HANS_TO_HANT: Record<string, string> = {
  这: "這", 个: "個", 问: "問", 题: "題", 请: "請", 用: "用", 简: "簡", 体: "體",
  中文: "中文", 回: "回", 答: "答", 学: "學", 习: "習", 么: "麼", 为: "為", 与: "與",
  说: "說", 让: "讓", 们: "們", 无: "無", 书: "書", 处: "處", 结: "結", 给: "給",
  别: "別", 带: "帶", 点: "點", 数: "數", 样: "樣", 后: "後", 发: "發", 现: "現",
  线: "線", 号: "號", 认: "認", 识: "識", 进: "進", 过: "過", 还: "還", 关: "關",
  于: "於", 义: "義", 语: "語", 话: "話", 时: "時", 间: "間", 东: "東", 车: "車",
  马: "馬", 网: "網", 软: "軟", 资: "資", 统: "統", 电: "電", 开: "開", 见: "見",
};
const SIMPLIFIED_LEAK = /[这问题请简体学习么为与说让们无书处结给别带点数样后发现线号认识进过还关于义语话时间东车马网软资统电开见龙]/;
const INSTRUCTION_ECHO = ["請用繁體中文清楚", "約 150 字以內", "切勿重複相同句子"];

export function postprocessTraditionalChinese(input: string): string {
  return [...String(input ?? "")].map((char) => HANS_TO_HANT[char] ?? char).join("")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

export function hasRepetitionLoop(text: string): boolean {
  for (let size = 1; size <= Math.min(32, Math.floor(text.length / 3)); size += 1) {
    const tail = text.slice(-size);
    const copies = size < 8 ? 4 : 3;
    if (text.length >= size * copies && text.endsWith(tail.repeat(copies))) return true;
  }
  return false;
}

export function validateLocalAnswer(question: string, rawAnswer: string): LocalAnswerVerdict {
  const answer = postprocessTraditionalChinese(rawAnswer);
  if (!answer) return { status: "INVALID", answer, reason: "empty-answer" };
  if (answer.length < 4) return { status: "INVALID", answer, reason: "too-short" };
  if (INSTRUCTION_ECHO.some((marker) => answer.includes(marker))) return { status: "INVALID", answer, reason: "instruction-echo" };
  if (hasRepetitionLoop(answer)) return { status: "INVALID", answer, reason: "repetition-loop" };
  const compactQuestion = question.replace(/\s/g, "");
  const compactAnswer = answer.replace(/\s/g, "");
  if (compactQuestion.length >= 4 && (compactAnswer === compactQuestion || compactQuestion.includes(compactAnswer))) {
    return { status: "INVALID", answer, reason: "question-echo" };
  }
  if (SIMPLIFIED_LEAK.test(answer)) return { status: "INVALID", answer, reason: "unresolved-simplified" };
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
