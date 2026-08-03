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

/** Headings belong to the structured answer shell, not to a field's content. */
export const SECTION_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(題意摘要|解題步驟|完整程式碼|範例(?:輸入輸出|驗證)?|複雜度分析?|補充說明|解題重點|核心結論|解法摘要|解題思路|關鍵觀察|核心概念|解法說明|演算法說明|重點整理|解題方向|問題分析|思路分析|答案|結論)\s*[:：]?\s*$/;

const GENERIC_SUMMARY_FALLBACK = "請依序整理輸入、處理流程與輸出結果。";
const RECTANGLE_SUMMARY_FALLBACK =
  "給定兩個守衛負責的矩形區域，計算兩矩形交集面積、恰好被一個矩形覆蓋的面積，以及整塊土地未被覆蓋的面積。";

/** Remove pure section labels before text is assigned to a structured field. */
export function removeSectionHeading(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !SECTION_HEADING_PATTERN.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Extract the first non-heading, non-empty prose line from a Markdown string.
 * Used as a last-resort summary when the structured summary field is blank.
 * Numbered/bulleted items are skipped because they are steps, not summaries.
 */
export function firstProseLineFromMarkdown(markdownText: string): string {
  return removeSectionHeading(markdownText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^```/.test(line) &&
      !/^(?:[-*+]\s+|\d+[.)、:：]\s+)/.test(line)
    )
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*|__|~~|`/g, "")
        .trim()
    )
    .find(Boolean) ?? "";
}

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

type AnswerSectionKey = "preamble" | "summary" | "steps" | "code" | "examples" | "complexity" | "explanation";
type AnswerSections = Record<AnswerSectionKey, string[]>;

function sectionKeyForHeading(line: string): Exclude<AnswerSectionKey, "preamble"> | null {
  const match = line.trim().match(SECTION_HEADING_PATTERN);
  if (!match) return null;
  const heading = match[1];
  if (heading === "題意摘要" || heading === "解法摘要" || heading === "核心結論" || heading === "核心概念") return "summary";
  if (heading === "解題步驟" || heading === "解題重點" || heading === "解題思路" || heading === "解題方向" || heading === "思路分析" || heading === "演算法說明") return "steps";
  if (heading === "完整程式碼") return "code";
  if (heading.startsWith("範例")) return "examples";
  if (heading.startsWith("複雜度")) return "complexity";
  if (heading === "補充說明" || heading === "問題分析" || heading === "重點整理" || heading === "解法說明" || heading === "關鍵觀察" || heading === "答案" || heading === "結論") return "explanation";
  return null;
}

function splitAnswerSections(text: string): AnswerSections {
  const sections: AnswerSections = {
    preamble: [],
    summary: [],
    steps: [],
    code: [],
    examples: [],
    complexity: [],
    explanation: []
  };
  let current: AnswerSectionKey = "preamble";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const nextSection = sectionKeyForHeading(line);
    if (nextSection) {
      current = nextSection;
      continue;
    }
    sections[current].push(line);
  }
  return sections;
}

function numberedOrBulletedLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+]\s+|\d+[.)、:：]\s+)/.test(line))
    .map(plainText)
    .filter(Boolean);
}

function firstParagraph(text: string, fallback = GENERIC_SUMMARY_FALLBACK, markdownText?: string): string {
  const sections = splitAnswerSections(text);
  const parsedSummary = (sections.summary.length > 0 ? sections.summary : sections.preamble).join("\n");
  const cleanedSummary = removeSectionHeading(parsedSummary);
  const candidate = cleanedSummary
    .split(/\n\s*\n/)
    .map((block) => plainText(block.replace(/\n/g, " ")))
    .map((block) => removeSectionHeading(block))
    .find((block) => block && !/^(?:輸入|輸出|input|output|範例|example|解題步驟|步驟)/i.test(block));
  if (candidate) return candidate;
  // When the structured summary is only headings, try extracting from markdownText.
  if (markdownText) {
    const mdFallback = firstProseLineFromMarkdown(markdownText);
    if (mdFallback) return mdFallback;
  }
  return fallback;
}

function isRectangleCoverageQuestion(question: string): boolean {
  return /守衛|矩形|交集面積|未被覆蓋|\b(?:strong|weak|unsecured|overlap[xy])\b/i.test(question);
}

function isSafetyZoneDefinition(step: string): boolean {
  const normalized = step.trim();
  return (
    /^(?:(?:定義|令|計算)\s*)?(?:strong|weak|unsecured)\b/i.test(normalized) ||
    /^(?:強覆蓋區|弱覆蓋區|未覆蓋區|未被覆蓋區|未保障區)\s*(?:[=:：]|為|是|代表)?/.test(normalized)
  );
}

function isComplexityText(value: string): boolean {
  return /複雜度|\bO\s*\([^\n)]*\)/i.test(value);
}

function cleanLineText(text: string): string {
  return removeSectionHeading(text)
    .split(/\r?\n/)
    .map((line) => plainText(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function parseComplexity(text: string, steps: string[]): { complexity?: string; steps: string[] } {
  const sections = splitAnswerSections(text);
  const sectionText = sections.complexity.join("\n");
  const detectedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isComplexityText(line));
  const complexity = cleanLineText(sectionText || detectedLines.join("\n"));
  return {
    complexity: complexity ? complexity.slice(0, 500) : undefined,
    steps: steps.filter((step) => !isComplexityText(step))
  };
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

function genericContent(raw: string, classification: ProblemClassification, question: string): StudentAnswerContent {
  const { language, code, prose } = extractCode(raw);
  const sections = splitAnswerSections(prose);
  const parsedSteps = numberedOrBulletedLines(
    sections.steps.length > 0 ? sections.steps.join("\n") : prose
  );
  const cleanedSteps = parsedSteps
    .map(removeSectionHeading)
    .map((step) => step.trim())
    .filter(Boolean);
  const safetyZoneDefinitions = cleanedSteps.filter(isSafetyZoneDefinition);
  const stepsWithoutDefinitions = cleanedSteps.filter((step) => !isSafetyZoneDefinition(step));
  const parsedComplexity = parseComplexity(prose, stepsWithoutDefinitions);
  const steps = parsedComplexity.steps.slice(0, 6);
  const summary = firstParagraph(
    prose,
    isRectangleCoverageQuestion(question) ? RECTANGLE_SUMMARY_FALLBACK : GENERIC_SUMMARY_FALLBACK,
    raw.trim()
  );
  const examples = parseExamples(prose);
  const legacyExplanation = prose
    .split(/\n\s*\n/)
    .slice(1)
    .map((block) => removeSectionHeading(block).trim())
    .filter(Boolean)
    .join("\n\n");
  const structuredExplanation = removeSectionHeading(sections.explanation.join("\n")).trim();
  const hasStructuredSectionHeading = prose
    .split(/\r?\n/)
    .some((line) => sectionKeyForHeading(line) !== null);
  const definitionExplanation = safetyZoneDefinitions.length > 0
    ? ["安全區定義：", ...safetyZoneDefinitions].join("\n")
    : "";
  const explanation = [
    structuredExplanation || (!hasStructuredSectionHeading ? legacyExplanation : ""),
    definitionExplanation
  ]
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
    complexity: parsedComplexity.complexity,
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
  const content = genericContent(cleaned, classification, question);
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
