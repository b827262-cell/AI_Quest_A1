import type { TaskCategory } from "../classification/classification-types";
import type {
  CodeExecutionPort,
  DomainVerificationStrategy,
  SafeCodeExecutionRequest,
  VerificationEvidence,
  VerificationStrategyContext
} from "./verification-evidence";
import { clampEvidenceConfidence, safeEvidenceIssue } from "./verification-evidence";

const DECLARATION = /\b(?:int|long|short|float|double|char|bool|string|var|let|const|auto)\s+([A-Za-z_]\w*)/g;
const IDENTIFIER = /\b[A-Za-z_]\w*\b/g;
const LANGUAGE_PATTERNS: Array<[string, RegExp]> = [
  ["c", /\b(?:c|c\+\+|cpp)\b|#include\s*</i],
  ["python", /\bpython\b|\bdef\s+[A-Za-z_]\w*\s*\(/i],
  ["javascript", /\b(?:javascript|typescript|node(?:\.js)?)\b|\b(?:const|let)\s+[A-Za-z_]/i],
  ["java", /\bjava\b|\bpublic\s+static\s+void\s+main\b/i]
];
const COMMON_IDENTIFIERS = new Set([
  "if", "else", "for", "while", "do", "return", "break", "continue", "switch", "case", "default",
  "int", "long", "short", "float", "double", "char", "bool", "void", "const", "static", "struct",
  "class", "public", "private", "protected", "true", "false", "null", "nullptr", "sizeof", "printf",
  "scanf", "main", "include", "stdio", "std", "cout", "cin", "using", "namespace", "def", "print",
  "function", "console", "log", "let", "var", "new", "this", "and", "or", "not", "is", "are"
]);

function hasCodeSignal(text: string): boolean {
  return /```|#include\s*<|\b(?:int|float|double|def|function|SELECT|INSERT|console\.log)\b/i.test(text);
}

function questionLanguage(question: string): string | undefined {
  return LANGUAGE_PATTERNS.find(([, pattern]) => pattern.test(question))?.[0];
}

function answerLanguage(answer: string): string | undefined {
  return LANGUAGE_PATTERNS.find(([, pattern]) => pattern.test(answer))?.[0];
}

function codeBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:[a-zA-Z+#-]+)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function declaredIdentifiers(source: string): Set<string> {
  const declared = new Set<string>();
  for (const match of source.matchAll(DECLARATION)) declared.add(match[1]);
  for (const match of source.matchAll(/\b(?:def|function)\s+([A-Za-z_]\w*)/g)) declared.add(match[1]);
  return declared;
}

function hasUndefinedVariable(question: string, answer: string): boolean {
  const blocks = codeBlocks(answer);
  const source = blocks.join("\n");
  const explicit = [...answer.matchAll(/(?:不存在|未宣告|undefined|undeclared)(?:的)?\s*(?:變數\s*)?([A-Za-z_]\w*)/gi)];
  const declared = declaredIdentifiers(question);
  if (explicit.some((match) => !declared.has(match[1]))) return true;
  if (/(?:不存在|未宣告|undefined|undeclared)/i.test(answer)) {
    const mentioned = answer.match(IDENTIFIER) ?? [];
    if (mentioned.some((identifier) => !declared.has(identifier) && !COMMON_IDENTIFIERS.has(identifier))) return true;
  }
  if (!source) return false;
  const known = declaredIdentifiers(`${question}\n${source}`);
  for (const token of source.match(IDENTIFIER) ?? []) {
    if (!known.has(token) && !COMMON_IDENTIFIERS.has(token) && token.length > 1 && !/^[A-Z_]+$/.test(token)) {
      return true;
    }
  }
  return false;
}

function sourceForExecution(answer: string): SafeCodeExecutionRequest | undefined {
  const source = codeBlocks(answer)[0];
  if (!source) return undefined;
  const language = answerLanguage(answer);
  return { language: (language as SafeCodeExecutionRequest["language"]) ?? "unknown", source };
}

/**
 * Safe programming verification. It only inspects text and code-shaped
 * snippets; it never executes student code. A reviewed sandbox can be injected
 * later through CodeExecutionPort, but the default remains unavailable.
 */
export class ProgrammingStaticVerifier implements DomainVerificationStrategy {
  readonly strategy = "programming_static" as const;

  constructor(private readonly runtime?: CodeExecutionPort) {}

  supports(category: TaskCategory): boolean {
    return category === "programming";
  }

  async verify(context: VerificationStrategyContext): Promise<VerificationEvidence> {
    const { question, primaryAnswer } = context;
    const issues = [];
    const questionLang = questionLanguage(question);
    const answerLang = answerLanguage(primaryAnswer);
    const hasPointerArrayCase = /&\s*[A-Za-z_]\w*\s*\+\s*1|\*\s*\(?[A-Za-z_]\w*\s*-\s*1|\[\s*\d+\s*\]/.test(question);

    if (hasUndefinedVariable(question, primaryAnswer)) {
      issues.push(safeEvidenceIssue("undefined_variable", "high", "answer_references_undeclared_variable"));
    }
    if (questionLang && answerLang && questionLang !== answerLang) {
      issues.push(safeEvidenceIssue("language_mismatch", "high", "answer_language_differs_from_question"));
    }
    if (/compile[- ]time|編譯期/i.test(question) && /runtime|執行期|執行時/i.test(primaryAnswer)) {
      issues.push(safeEvidenceIssue("compile_runtime", "medium", "compile_time_and_runtime_are_conflated"));
    }

    const mentionsUndefined = /undefined behavior|未定義行為|未定義|越界|out[- ]of[- ]bounds/i.test(question);
    if (mentionsUndefined && /一定|必定|固定輸出|always|必然|guaranteed/i.test(primaryAnswer)) {
      issues.push(safeEvidenceIssue("undefined_behavior", "high", "undefined_behavior_claimed_as_fixed_output"));
    }

    if (hasPointerArrayCase) {
      const distinguishesPointerEnd = /&\s*[A-Za-z_]\w*\s*\+\s*1|陣列之外|array.*end|one[ -]?past|p\s*-\s*1|p - 1|p-1/i.test(primaryAnswer);
      const confusesDereference = /\*p\s*-\s*1\s*(?:等於|等同|相同|就是|equivalent|same)|\*p\s*-\s*1.*\*\s*\(\s*p\s*-\s*1\s*\)/i.test(primaryAnswer);
      if (confusesDereference || (!distinguishesPointerEnd && /\*p|p\b/i.test(primaryAnswer))) {
        issues.push(safeEvidenceIssue("pointer_array", "high", "pointer_arithmetic_or_dereference_is_misread"));
      }
    }

    if (
      codeBlocks(question).length > 0 &&
      !hasCodeSignal(primaryAnswer) &&
      !/\b(?:p|a|array|pointer|code|program)\b|指標|陣列|程式/i.test(primaryAnswer) &&
      primaryAnswer.trim().length < 80
    ) {
      issues.push(safeEvidenceIssue("missing_code_analysis", "high", "answer_does_not_address_the_program"));
    }

    const executionRequest = sourceForExecution(primaryAnswer);
    const runtimeVerification = this.runtime?.isAvailable() && executionRequest ? "available" : "unavailable";
    if (this.runtime?.isAvailable() && executionRequest) {
      try {
        const result = await this.runtime.execute(executionRequest);
        if (result.status === "failed") {
          issues.push(safeEvidenceIssue("runtime", "high", "safe_runtime_check_failed"));
        }
      } catch {
        issues.push(safeEvidenceIssue("runtime", "medium", "safe_runtime_check_unavailable"));
      }
    }

    const high = issues.some((issue) => issue.severity === "high");
    const status = high ? "failed" : issues.length > 0 || runtimeVerification === "unavailable" ? "partial" : "passed";
    return {
      strategy: this.strategy,
      status,
      confidence: clampEvidenceConfidence(status === "failed" ? 0.95 : status === "passed" ? 0.9 : 0.65),
      issues,
      safeSummary: high ? "high_severity_static_issue" : status === "partial" ? "static_checks_partial" : "static_checks_passed",
      runtimeVerification
    };
  }
}
