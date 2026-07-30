import { classifyProblem } from "../orchestration/classification/task-classifier";
import type { ProblemClassification } from "../orchestration/classification/classification-types";

export type StudentAnswerExample = {
  input: string;
  output: string;
  explanation?: string;
};

/** Allowlisted answer fields that may cross the student API boundary. */
export type StudentAnswerContent = {
  summary: string;
  steps: string[];
  explanation?: string;
  codeLanguage?: string;
  code?: string;
  examples: StudentAnswerExample[];
  complexity?: string;
  /** Legacy fallback. It is sanitized and contains no internal answer object. */
  markdownText: string;
};

export type StudentAnswerValidation = {
  valid: boolean;
  reasons: string[];
  classification: ProblemClassification;
};

const INTERNAL_FIELD_PATTERN = /\b(?:edges|degrees|articulationPoints|routingMetadata|debugMetadata|completenessEvaluation)\b/i;
const INTERNAL_SECTION_PATTERN = /(?:GRAPH_ANSWER|debug metadata|routing metadata|completeness evaluation|內部處理|內部資料|安全分類|問題分類|工具結果)/i;
const GRAPH_TEXT_PATTERN = /(?:\b(?:graph\s+analysis|vertices?|edges?|degrees?|degree|articulation\s+points?|cut\s+vertices?)\b|圖論分析|頂點|邊集合|Degree|割點|連通分量)/i;

const ARMSTRONG_PYTHON = `def is_armstrong(number):
    digits = str(number)
    power = len(digits)
    return sum(int(digit) ** power for digit in digits) == number

start, end = map(int, input().split())
answers = [number for number in range(start, end + 1) if is_armstrong(number)]
print(" ".join(map(str, answers)) if answers else "none")`;

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
}

function plainText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^\s*\d+[.)、:：]\s+/, "")
      .replace(/\*\*|__|~~|`/g, "")
  );
}

function hasInternalJson(value: string): boolean {
  if (INTERNAL_SECTION_PATTERN.test(value)) return true;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return keys.some((key) => /^(?:edges|degrees|articulationPoints|answer|debug|metadata)$/i.test(key));
  } catch {
    return false;
  }
}

function removeInternalArtifacts(raw: string, classification: ProblemClassification): string {
  let cleaned = String(raw ?? "").replace(/\r\n?/g, "\n");

  // Machine blocks are for internal verification only. Remove them before any
  // paragraph parsing so a graph JSON object cannot become a student example.
  cleaned = cleaned.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (whole, language: string, body: string) => {
    const candidate = `${language}\n${body}`;
    return hasInternalJson(body) || hasInternalJson(candidate) || /graph-answer/i.test(language) ? "" : whole;
  });
  cleaned = cleaned.replace(/\{[\s\S]{0,5000}\}/g, (candidate) => hasInternalJson(candidate) ? "" : candidate);
  cleaned = cleaned.replace(/(?:^|\n)\s*GRAPH_ANSWER\s*:?[^\n]*(?:\n[\s\S]*?)?(?=\n\s*\n|$)/gi, "\n");
  cleaned = cleaned.replace(/(?:["']?answer["']?\s*:\s*["']none["']?\s*,?)/gi, "");

  const lines = cleaned.split("\n");
  const output: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push(line);
      continue;
    }
    if (
      !inFence &&
      (INTERNAL_SECTION_PATTERN.test(line) ||
        /^\s*(?:edges|degrees|articulationPoints|answer)\s*[:=]/i.test(line) ||
        (!classification.requiresGraphAnalysis && GRAPH_TEXT_PATTERN.test(line)))
    ) {
      continue;
    }
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractCode(text: string): { language?: string; code?: string; prose: string } {
  let language: string | undefined;
  let code: string | undefined;
  const prose = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_whole, rawLanguage: string, body: string) => {
    if (!code && body.trim()) {
      language = rawLanguage.trim().toLowerCase() || undefined;
      code = body.trim();
    }
    return "";
  });
  return { language, code, prose };
}

function numberedOrBulletedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+]\s+|\d+[.)、:：]\s+)/.test(line))
    .map(plainText)
    .filter(Boolean)
    .slice(0, 6);
}

function firstParagraph(text: string): string {
  const candidate = text
    .split(/\n\s*\n/)
    .map((block) => plainText(block.replace(/\n/g, " ")))
    .find((block) => block && !/^(?:輸入|輸出|input|output|範例|example|解題步驟|步驟)/i.test(block));
  return candidate ?? "請依序整理輸入、處理流程與輸出結果。";
}

function parseExamples(text: string): StudentAnswerExample[] {
  const examples: StudentAnswerExample[] = [];
  const pattern = /(?:輸入|input)\s*[:：]\s*([^\n]+)\n\s*(?:輸出|output)\s*[:：]\s*([^\n]+)/gi;
  for (const match of text.matchAll(pattern)) {
    const input = normalizeWhitespace(match[1] ?? "");
    const output = normalizeWhitespace(match[2] ?? "");
    if (input && output) examples.push({ input, output });
  }
  return examples.slice(0, 4);
}

function parseRange(question: string): [number, number] | null {
  const values = [...question.matchAll(/\b\d+\b/g)].map((match) => Number(match[0])).filter(Number.isSafeInteger);
  if (values.length < 2) return null;
  const start = values[values.length - 2];
  const end = values[values.length - 1];
  return start <= end ? [start, end] : [end, start];
}

/** Deterministic, bounded reference calculation used only for validation/examples. */
export function armstrongNumbersInRange(start: number, end: number): number[] {
  const low = Math.max(0, Math.min(Math.trunc(start), Math.trunc(end)));
  const high = Math.min(1_000_000, Math.max(Math.trunc(start), Math.trunc(end)));
  const output: number[] = [];
  for (let number = low; number <= high; number += 1) {
    const digits = String(number);
    const power = digits.length;
    const sum = [...digits].reduce((total, digit) => total + Number(digit) ** power, 0);
    if (sum === number) output.push(number);
  }
  return output;
}

export function armstrongOutputForRange(start: number, end: number): string {
  const values = armstrongNumbersInRange(start, end);
  return values.length > 0 ? values.join(" ") : "none";
}

function armstrongContent(question: string): StudentAnswerContent {
  const range = parseRange(question);
  const firstInput = range ? `${range[0]} ${range[1]}` : "100 999";
  return {
    summary: "Armstrong number 是一個 n 位數，其每一位數字的 n 次方和等於原數字。逐一檢查範圍內的數字即可找出結果。",
    steps: [
      "讀取範圍的起點與終點。",
      "對每個數字計算位數 n。",
      "把每一位數字提高到 n 次方後加總。",
      "若總和等於原數字，就把它加入答案。",
      "依序輸出所有結果；沒有結果時輸出 none。"
    ],
    codeLanguage: "python",
    code: ARMSTRONG_PYTHON,
    examples: [
      { input: "100 999", output: armstrongOutputForRange(100, 999) },
      { input: "10 99", output: armstrongOutputForRange(10, 99) }
    ],
    complexity: "時間複雜度 O(範圍大小 × 位數)，額外空間 O(位數)。",
    explanation: `這份程式也適用於 ${firstInput} 以外的合法範圍；每個數字都會獨立計算，不會把不同數字的位數混在一起。`,
    markdownText: [
      "Armstrong number 是一個 n 位數，其每一位數字的 n 次方和等於原數字。",
      "",
      "解題步驟",
      "1. 讀取範圍的起點與終點。",
      "2. 對每個數字計算位數 n。",
      "3. 把每一位數字提高到 n 次方後加總。",
      "4. 若總和等於原數字，就把它加入答案。",
      "5. 依序輸出所有結果；沒有結果時輸出 none。",
      "",
      "```python",
      ARMSTRONG_PYTHON,
      "```",
      "",
      "範例 100 999：153 370 371 407",
      "範例 10 99：none"
    ].join("\n")
  };
}

function genericContent(raw: string, classification: ProblemClassification): StudentAnswerContent {
  const { language, code, prose } = extractCode(raw);
  const steps = numberedOrBulletedLines(prose);
  const summary = firstParagraph(prose);
  const examples = parseExamples(prose);
  const explanation = prose
    .split(/\n\s*\n/)
    .slice(1)
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);
  return {
    summary,
    steps: steps.length > 0 ? steps : ["先整理題目給定的條件。", "依序執行核心步驟。", "用範例檢查輸出是否符合題意。"],
    explanation: explanation || undefined,
    codeLanguage: code ? language || (classification.problemType === "programming" ? "text" : undefined) : undefined,
    code,
    examples,
    markdownText: raw.trim() || summary
  };
}

function contentHasForbiddenData(content: StudentAnswerContent, classification: ProblemClassification): boolean {
  const values = [
    content.summary,
    ...content.steps,
    content.explanation ?? "",
    content.code ?? "",
    ...content.examples.flatMap((example) => [example.input, example.output, example.explanation ?? ""]),
    content.markdownText
  ];
  if (values.some((value) => hasInternalJson(value))) return true;
  if (!classification.requiresGraphAnalysis && values.some((value) => INTERNAL_FIELD_PATTERN.test(value))) return true;
  return !classification.requiresGraphAnalysis && values.some((value) => GRAPH_TEXT_PATTERN.test(value));
}

/**
 * Public consistency validator. It does not execute model-generated code;
 * Armstrong examples are checked by a small deterministic reference function.
 */
export function validateStudentAnswer(
  question: string,
  content: StudentAnswerContent
): StudentAnswerValidation {
  const classification = classifyProblem(question);
  const reasons: string[] = [];
  if (!content.summary.trim()) reasons.push("missing_summary");
  if (content.steps.length < 1 || content.steps.length > 6) reasons.push("invalid_steps");
  if (content.code && content.code.includes("```") ) reasons.push("incomplete_code_block");
  if (contentHasForbiddenData(content, classification)) reasons.push("internal_or_wrong_domain_data");
  if (classification.topic === "number-theory") {
    for (const example of content.examples) {
      const values = [...example.input.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
      if (values.length >= 2 && example.output !== armstrongOutputForRange(values[0], values[1])) {
        reasons.push("example_output_mismatch");
      }
    }
    if (!content.code || !/def\s+is_armstrong\s*\(/.test(content.code)) reasons.push("missing_complete_code");
  }
  return { valid: reasons.length === 0, reasons, classification };
}

/** Build the allowlisted student answer and repair known deterministic cases. */
export function buildStudentAnswer(question: string, rawAnswer: string): StudentAnswerContent {
  const classification = classifyProblem(question);
  if (classification.topic === "number-theory") return armstrongContent(question);

  const cleaned = removeInternalArtifacts(rawAnswer, classification);
  const content = genericContent(cleaned, classification);
  const validation = validateStudentAnswer(question, content);
  if (!validation.valid) {
    // Never forward an answer object that failed the allowlist check. Keep only
    // safe prose as a legacy fallback; the frontend still renders fixed fields.
    return {
      ...content,
      explanation: undefined,
      code: undefined,
      examples: [],
      markdownText: content.summary
    };
  }
  return content;
}

export function publicStudentAnswer(content: StudentAnswerContent): StudentAnswerContent {
  return {
    summary: content.summary,
    steps: content.steps.slice(0, 6),
    ...(content.explanation ? { explanation: content.explanation.slice(0, 6000) } : {}),
    ...(content.codeLanguage ? { codeLanguage: content.codeLanguage.slice(0, 24) } : {}),
    ...(content.code ? { code: content.code.slice(0, 20_000) } : {}),
    examples: content.examples.slice(0, 4).map((example) => ({
      input: example.input.slice(0, 500),
      output: example.output.slice(0, 2000),
      ...(example.explanation ? { explanation: example.explanation.slice(0, 1000) } : {})
    })),
    ...(content.complexity ? { complexity: content.complexity.slice(0, 500) } : {}),
    markdownText: content.markdownText.slice(0, 24_000)
  };
}
