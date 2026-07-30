import type {
  ProblemClassification,
  ProblemTopic,
  ProblemType,
  TaskCategory,
  TaskClassification
} from "./classification-types";

/**
 * Graph analysis is opt-in. Keep this list explicit so a generic programming
 * question cannot accidentally activate the graph prompt or graph fields.
 */
export const GRAPH_ANALYSIS_PATTERN = /(?:\b(?:graph|vertex|vertices|edge|edges|adjacency|dfs|bfs|mst|kruskal|prim|spanning\s+tree|articulation\s+points?|cut\s+vertices?|bridge|degree|connected\s+components?)\b|圖論|圖形|頂點|邊集合|相鄰|鄰接|深度優先|廣度優先|最小生成樹|生成樹|割點|橋|度數|連通分量)/i;

export function requiresGraphAnalysis(question: string): boolean {
  return GRAPH_ANALYSIS_PATTERN.test(question);
}

function problemTopic(question: string, problemType: ProblemType): ProblemTopic {
  if (/armstrong\s*(?:number|numbers)?|阿姆斯壯|水仙花數|n\s*位數.*次方|位數.*次方/i.test(question)) {
    return "number-theory";
  }
  if (problemType === "graph") return "graph-algorithm";
  if (problemType === "programming") return /演算法|algorithm|排序|sort|複雜度|complexity/i.test(question) ? "algorithm" : "general";
  if (/方程|等式|代數|equation|algebra/i.test(question)) return "algebra";
  if (/幾何|三角形|圓形|geometry|triangle/i.test(question)) return "geometry";
  return "general";
}

/**
 * Single deterministic gate for answer modules. It is deliberately separate
 * from provider routing: the result controls which answer sections may be
 * produced, not which provider is allowed to receive the question.
 */
export function classifyProblem(question: string): ProblemClassification {
  const text = typeof question === "string" ? question : "";
  const graph = requiresGraphAnalysis(text);
  const programming = matches(PROGRAMMING_PATTERNS, text).length > 0;
  const mathematics = matches(MATHEMATICS_PATTERNS, text).length > 0;
  const problemType: ProblemType = graph
    ? "graph"
    : programming
      ? "programming"
      : mathematics
        ? "mathematics"
        : "general";
  return {
    problemType,
    topic: problemTopic(text, problemType),
    requiresGraphAnalysis: graph
  };
}

const PROGRAMMING_PATTERNS: Array<[string, RegExp]> = [
  ["code_fence", /```[\s\S]*```/i],
  ["programming_language", /\b(?:c\+\+|c#|c|python|java(?:script)?|typescript|rust|go|sql|php|ruby|kotlin|swift)\b/i],
  ["programming_concept", /指標|指针|pointer|array|陣列|function|函式|class|compiler|編譯|runtime|執行期|undefined behavior|api|sql|debug|除錯|refactor|重構|complexity|複雜度|(?<!方)程式|程式碼|程式設計|code/i]
];

const MATHEMATICS_PATTERNS: Array<[string, RegExp]> = [
  ["equation", /方程式?|等式|solve for|equation|證明|proof|推導|derive/i],
  ["statistics", /百分比|比例|機率|概率|統計|平均數|中位數|percent|probability|statistics/i],
  ["geometry", /幾何|三角形|圓形|面積|體積|geometry|triangle|area|volume/i],
  ["numeric_expression", /[-+]?\d+(?:\.\d+)?\s*(?:[+\-*/×÷^()]\s*[-+]?\d+(?:\.\d+)?|%)/]
];

const KNOWLEDGE_PATTERNS: Array<[string, RegExp]> = [
  ["definition", /是什麼|什麼是|定義|解釋|說明|what is|define|definition|explain/i],
  ["comparison", /比較|差異|不同|優缺點|compare|difference|versus|vs\.?/i],
  ["cause_analysis", /為什麼|原因|如何影響|why|cause|impact|history|歷史|科學|管理|語言/i]
];

function matches(patterns: Array<[string, RegExp]>, text: string): string[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
}

/**
 * Classifies only from bounded lexical signals. It never calls a provider and
 * never includes user content in its result.
 */
export function classifyTaskCategory(question: string): TaskClassification {
  const programmingReasons = matches(PROGRAMMING_PATTERNS, question);
  if (programmingReasons.length > 0) {
    return { category: "programming", confidence: programmingReasons.length > 1 ? 0.98 : 0.9, source: "deterministic", reasons: programmingReasons };
  }

  const mathematicsReasons = matches(MATHEMATICS_PATTERNS, question);
  if (mathematicsReasons.length > 0) {
    return { category: "mathematics", confidence: mathematicsReasons.length > 1 ? 0.98 : 0.9, source: "deterministic", reasons: mathematicsReasons };
  }

  const knowledgeReasons = matches(KNOWLEDGE_PATTERNS, question);
  if (knowledgeReasons.length > 0) {
    return { category: "knowledge", confidence: knowledgeReasons.length > 1 ? 0.92 : 0.82, source: "deterministic", reasons: knowledgeReasons };
  }

  return { category: "unknown", confidence: 0.2, source: "fallback", reasons: ["no_reliable_signal"] };
}

export function isTaskCategory(value: unknown): value is TaskCategory {
  return value === "programming" || value === "mathematics" || value === "knowledge" || value === "unknown";
}

/** Alias kept explicit so callers do not confuse this with the Router task classifier. */
export const classifyTask = classifyTaskCategory;
