import type { RetrievedChunk } from "./ports";

export type InjectionSource = "user" | "document";
export type InjectionDecision = "allow" | "allow_with_isolation" | "block";

export type InjectionReasonCode =
  | "NONE"
  | "DIRECT_OVERRIDE"
  | "AUTHORITY_SPOOFING"
  | "SECRET_EXFILTRATION"
  | "TOOL_EXECUTION"
  | "ROLE_MARKUP"
  | "SUSPICIOUS_INSTRUCTION";

export type InjectionScreeningResult = {
  decision: InjectionDecision;
  reasonCode: InjectionReasonCode;
};

const DIRECT_OVERRIDE = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|earlier|above)\s+instructions?/i,
  /忽略(?:所有|之前|先前|上面|原本的)?(?:指令|規則|安全規則)/i,
  /disregard\s+(the\s+)?system\s+message/i,
  /override\s+(the\s+)?safety\s+(rules?|policy)/i,
  /ignore\s+(the\s+)?safety\s+(rules?|policy)/i,
  /you\s+are\s+now\s+(?:the\s+)?(?:system|admin|developer)/i,
  /你現在是(?:系統|管理員|開發者)/i
];
const SECRET_EXFILTRATION = [
  /(reveal|show|print|output|exfiltrate).{0,50}(system\s+prompt|hidden\s+prompt|secret|api\s*key|credential)/i,
  /(顯示|透露|輸出|洩漏).{0,30}(系統提示|秘密|金鑰|憑證)/i,
  /system\s+prompt.{0,30}(verbatim|exactly|原文)/i
];
const TOOL_EXECUTION = [
  /(call|invoke|execute|run)\s+(the\s+)?(tool|function|command)/i,
  /(執行|呼叫|使用).{0,20}(工具|函式|命令)/i,
  /<\s*(tool|function|system|admin)\b[^>]*>/i
];
const AUTHORITY_SPOOFING = [
  /(?:^|\n)\s*(?:system|developer|assistant|admin|tool)\s*:/im,
  /\b(?:system|developer|admin)\s+(?:instruction|override|directive)\b/i,
  /(?:^|\n)\s*(?:系統|管理員|工具|開發者)\s*[:：]/m,
  /BEGIN_(?:SYSTEM|ADMIN|TOOL)_MESSAGE/i
];

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Screen untrusted text before it can enter an LLM prompt. This is a
 * deterministic policy signal, not a prompt-only defense: blocked content is
 * removed by the orchestration layer and no tool execution is exposed.
 */
export function screenPromptInjection(text: string, source: InjectionSource): InjectionScreeningResult {
  if (matches(SECRET_EXFILTRATION, text)) {
    return { decision: "block", reasonCode: "SECRET_EXFILTRATION" };
  }
  if (matches(TOOL_EXECUTION, text)) {
    return { decision: "block", reasonCode: "TOOL_EXECUTION" };
  }
  if (matches(DIRECT_OVERRIDE, text)) {
    return {
      decision: source === "user" ? "block" : "allow_with_isolation",
      reasonCode: "DIRECT_OVERRIDE"
    };
  }
  if (matches(AUTHORITY_SPOOFING, text)) {
    return {
      decision: source === "user" ? "block" : "allow_with_isolation",
      reasonCode: "AUTHORITY_SPOOFING"
    };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    return { decision: "allow_with_isolation", reasonCode: "SUSPICIOUS_INSTRUCTION" };
  }
  if (matches([/\b(?:system|admin|developer|tool)\b/i, /(?:系統|管理員|工具|開發者)/], text)) {
    return { decision: "allow_with_isolation", reasonCode: "ROLE_MARKUP" };
  }
  return { decision: "allow", reasonCode: "NONE" };
}

export type ScreenedRetrievedChunks = {
  chunks: RetrievedChunk[];
  isolatedChunkIds: string[];
  blockedChunkIds: string[];
  reasonCodes: InjectionReasonCode[];
};

export function screenRetrievedChunks(chunks: readonly RetrievedChunk[]): ScreenedRetrievedChunks {
  const safe: RetrievedChunk[] = [];
  const isolatedChunkIds: string[] = [];
  const blockedChunkIds: string[] = [];
  const reasonCodes = new Set<InjectionReasonCode>();
  for (const chunk of chunks) {
    const result = screenPromptInjection(chunk.content, "document");
    reasonCodes.add(result.reasonCode);
    if (result.decision === "block") {
      blockedChunkIds.push(chunk.id);
      continue;
    }
    if (result.decision === "allow_with_isolation") isolatedChunkIds.push(chunk.id);
    safe.push({ ...chunk, content: result.decision === "allow_with_isolation" ? isolate(chunk.content) : chunk.content });
  }
  return { chunks: safe, isolatedChunkIds, blockedChunkIds, reasonCodes: [...reasonCodes].filter((code) => code !== "NONE") };
}

function isolate(content: string): string {
  return `[UNTRUSTED_DOCUMENT_DATA]\n${content}\n[/UNTRUSTED_DOCUMENT_DATA]`;
}
