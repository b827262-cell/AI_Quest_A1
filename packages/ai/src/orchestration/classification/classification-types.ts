export type TaskCategory = "programming" | "mathematics" | "knowledge" | "unknown";

/** Student-facing problem family used to gate answer modules. */
export type ProblemType = "programming" | "graph" | "mathematics" | "general";

/** Narrow topic labels are internal routing data and are never public output. */
export type ProblemTopic =
  | "number-theory"
  | "graph-algorithm"
  | "algorithm"
  | "algebra"
  | "geometry"
  | "general";

export interface ProblemClassification {
  problemType: ProblemType;
  topic: ProblemTopic;
  requiresGraphAnalysis: boolean;
}

export interface TaskClassification {
  category: TaskCategory;
  confidence: number;
  source: "deterministic" | "model" | "fallback";
  /** Short, allowlisted reason codes; never contains the question text. */
  reasons: string[];
}

export type OrchestrationStage =
  | "classification"
  | "domain_verification"
  | "verification"
  | "adjudication";
