import type { TaskCategory } from "../classification/classification-types";
import type {
  DomainVerificationStrategy,
  NumericVerificationResult,
  VerificationEvidence,
  VerificationStrategyContext
} from "./verification-evidence";
import { clampEvidenceConfidence, safeEvidenceIssue } from "./verification-evidence";

type LinearValue = { constant: number; coefficient: number };
type Token = { kind: "number" | "operator" | "variable" | "left" | "right"; value: string };

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const match = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match || !Number.isFinite(Number(match[0]))) return undefined;
      tokens.push({ kind: "number", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (/[xX]/.test(character)) {
      tokens.push({ kind: "variable", value: "x" });
      index += 1;
      continue;
    }
    if (character === "(") tokens.push({ kind: "left", value: character });
    else if (character === ")") tokens.push({ kind: "right", value: character });
    else if (/[+\-*/^×÷]/.test(character)) tokens.push({ kind: "operator", value: character === "×" ? "*" : character === "÷" ? "/" : character });
    else return undefined;
    index += 1;
  }
  const normalized: Token[] = [];
  for (const token of tokens) {
    const previous = normalized.at(-1);
    if (
      previous &&
      (previous.kind === "number" || previous.kind === "variable" || previous.kind === "right") &&
      (token.kind === "number" || token.kind === "variable" || token.kind === "left")
    ) normalized.push({ kind: "operator", value: "*" });
    normalized.push(token);
  }
  return normalized.length > 0 ? normalized : undefined;
}

class SafeExpressionParser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): LinearValue | undefined {
    const result = this.additive();
    return result && this.index === this.tokens.length ? result : undefined;
  }

  private additive(): LinearValue | undefined {
    let left = this.multiplicative();
    while (left && this.peekOperator("+", "-")) {
      const operator = this.tokens[this.index++].value;
      const right = this.multiplicative();
      if (!right) return undefined;
      left = operator === "+" ? add(left, right) : subtract(left, right);
    }
    return left;
  }

  private multiplicative(): LinearValue | undefined {
    let left = this.power();
    while (left && this.peekOperator("*", "/")) {
      const operator = this.tokens[this.index++].value;
      const right = this.power();
      if (!right) return undefined;
      const next = operator === "*" ? multiply(left, right) : divide(left, right);
      if (!next) return undefined;
      left = next;
    }
    return left;
  }

  private power(): LinearValue | undefined {
    const base = this.unary();
    if (!base) return undefined;
    if (!this.peekOperator("^")) return base;
    this.index += 1;
    const exponent = this.unary();
    if (!exponent || exponent.coefficient !== 0 || !Number.isInteger(exponent.constant) || exponent.constant < 0 || exponent.constant > 12) return undefined;
    if (base.coefficient !== 0 && exponent.constant > 1) return undefined;
    return { constant: base.constant ** exponent.constant, coefficient: 0 };
  }

  private unary(): LinearValue | undefined {
    if (this.peekOperator("+", "-")) {
      const operator = this.tokens[this.index++].value;
      const value = this.unary();
      if (!value) return undefined;
      return operator === "-" ? { constant: -value.constant, coefficient: -value.coefficient } : value;
    }
    const token = this.tokens[this.index];
    if (!token) return undefined;
    if (token.kind === "number") {
      this.index += 1;
      return { constant: Number(token.value), coefficient: 0 };
    }
    if (token.kind === "variable") {
      this.index += 1;
      return { constant: 0, coefficient: 1 };
    }
    if (token.kind === "left") {
      this.index += 1;
      const value = this.additive();
      if (!value || this.tokens[this.index]?.kind !== "right") return undefined;
      this.index += 1;
      return value;
    }
    return undefined;
  }

  private peekOperator(...operators: string[]): boolean {
    const token = this.tokens[this.index];
    return token?.kind === "operator" && operators.includes(token.value);
  }
}

function add(left: LinearValue, right: LinearValue): LinearValue {
  return { constant: left.constant + right.constant, coefficient: left.coefficient + right.coefficient };
}

function subtract(left: LinearValue, right: LinearValue): LinearValue {
  return { constant: left.constant - right.constant, coefficient: left.coefficient - right.coefficient };
}

function multiply(left: LinearValue, right: LinearValue): LinearValue | undefined {
  if (left.coefficient !== 0 && right.coefficient !== 0) return undefined;
  return {
    constant: left.constant * right.constant,
    coefficient: left.coefficient * right.constant + right.coefficient * left.constant
  };
}

function divide(left: LinearValue, right: LinearValue): LinearValue | undefined {
  if (right.coefficient !== 0 || right.constant === 0) return undefined;
  return { constant: left.constant / right.constant, coefficient: left.coefficient / right.constant };
}

function parseExpression(expression: string): LinearValue | undefined {
  const tokens = tokenize(expression.replace(/%/g, "/100"));
  return tokens ? new SafeExpressionParser(tokens).parse() : undefined;
}

function extractEquation(question: string): [string, string] | undefined {
  const match = question.match(/([-+\dxX.\s()*/^×÷]+)=\s*([-+\dxX.\s()*/^÷×]+)/i);
  return match ? [match[1], match[2]] : undefined;
}

function extractExpression(question: string): string | undefined {
  const equation = extractEquation(question);
  if (equation) return undefined;
  const normalizedQuestion = question.replace(/米|公尺|公分|公尺|公斤|千克|kg|cm|m\b/gi, "");
  const matches = normalizedQuestion.match(/[-+]?\d+(?:\.\d+)?%?(?:\s*[+\-*/^×÷()]\s*[-+]?\d+(?:\.\d+)?%?)+/g);
  return matches?.sort((left, right) => right.length - left.length)[0];
}

function percentageOf(question: string): number | undefined {
  const match = question.match(/([-+]?\d+(?:\.\d+)?)\s*%\s*(?:of|的)\s*([-+]?\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const percentage = Number(match[1]);
  const base = Number(match[2]);
  return Number.isFinite(percentage) && Number.isFinite(base) ? (percentage / 100) * base : undefined;
}

function extractAnswerNumber(answer: string): number | undefined {
  const matches = [...answer.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?/g)];
  const value = matches.at(-1)?.[0];
  if (!value) return undefined;
  const percent = value.endsWith("%");
  const numeric = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(numeric)) return undefined;
  return percent ? numeric / 100 : numeric;
}

export function evaluateSafeExpression(expression: string): number | undefined {
  const value = parseExpression(expression);
  if (!value || value.coefficient !== 0 || !Number.isFinite(value.constant)) return undefined;
  return value.constant;
}

export function verifyNumericAnswer(
  question: string,
  answer: string
): NumericVerificationResult {
  const equation = extractEquation(question);
  let expectedValue: number | undefined;
  let expression: string | undefined;
  const percentageResult = percentageOf(question);
  if (percentageResult !== undefined) {
    expression = "percentage_of";
    expectedValue = percentageResult;
  }
  if (equation) {
    const left = parseExpression(equation[0]);
    const right = parseExpression(equation[1]);
    if (left && right && left.coefficient !== right.coefficient) {
      expectedValue = (right.constant - left.constant) / (left.coefficient - right.coefficient);
      expression = "linear_equation";
    }
  } else if (expectedValue === undefined) {
    expression = extractExpression(question);
    expectedValue = expression ? evaluateSafeExpression(expression) : undefined;
  }
  const answerValue = extractAnswerNumber(answer);
  const tolerance = expectedValue === undefined ? undefined : Math.max(1e-9, Math.abs(expectedValue) * 1e-9);
  const matched = expectedValue !== undefined && answerValue !== undefined && Number.isFinite(answerValue)
    ? Math.abs(expectedValue - answerValue) <= (tolerance ?? 0)
    : undefined;
  return { expression, expectedValue, answerValue, tolerance, matched };
}

export class MathematicsVerifier implements DomainVerificationStrategy {
  supports(category: TaskCategory): boolean {
    return category === "mathematics";
  }

  async verify(context: VerificationStrategyContext): Promise<VerificationEvidence> {
    const result = verifyNumericAnswer(context.question, context.primaryAnswer);
    const issues = [];
    if (/\/\s*0(?:\.0+)?\b|除以零|除以 0/i.test(context.question)) {
      issues.push(safeEvidenceIssue("division_by_zero", "high", "division_by_zero_is_not_valid"));
    }
    if (/NaN|Infinity|無限大/i.test(context.primaryAnswer)) {
      issues.push(safeEvidenceIssue("non_finite", "high", "non_finite_numeric_result_rejected"));
    }
    if (result.matched === false) {
      issues.push(safeEvidenceIssue("numeric_mismatch", "high", "deterministic_recalculation_differs"));
    }
    const questionUnit = context.question.match(/(?:米|公尺|公分|公斤|千克|kg|cm|m\b)/i)?.[0].toLocaleLowerCase();
    const answerUnit = context.primaryAnswer.match(/(?:米|公尺|公分|公斤|千克|kg|cm|m\b)/i)?.[0].toLocaleLowerCase();
    if (questionUnit && answerUnit && questionUnit !== answerUnit) {
      issues.push(safeEvidenceIssue("unit_mismatch", "medium", "answer_unit_differs_from_question"));
    }
    const status = issues.some((issue) => issue.severity === "high")
      ? "failed"
      : result.matched === true && issues.length === 0
        ? "passed"
        : issues.length > 0
          ? "partial"
          : "unavailable";
    return {
      strategy: "mathematical_numeric",
      status,
      confidence: clampEvidenceConfidence(status === "passed" ? 0.98 : status === "failed" ? 0.98 : 0),
      issues,
      safeSummary: status === "passed" ? "numeric_recalculation_passed" : status === "failed" ? "numeric_check_failed" : "numeric_parser_unavailable"
    };
  }
}
