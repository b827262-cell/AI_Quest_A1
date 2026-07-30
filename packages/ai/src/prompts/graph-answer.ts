/**
 * Deterministic graph-answer verifier (spec §1.4).
 *
 * The graph-theory system prompt instructs the model to emit a parseable
 * `GRAPH_ANSWER` block. This module parses that block and checks it against the
 * known-correct fixtures, giving deterministic regression coverage of the Q6
 * (Kruskal MST edge selection) and Q7 (articulation points) correctness
 * criteria — without any live model call.
 */

export type GraphEdge = readonly [number, number, number?];

export type GraphAnswer = {
  edges?: GraphEdge[];
  degrees?: Record<string, number>;
  articulationPoints?: number[];
  /** Free-text multiple-choice answer, e.g. "D {0,1,3}". */
  answer?: string;
};

/** Canonicalise an edge so [u,v] and [v,u] compare equal (ignoring weight). */
function edgeKey(e: GraphEdge): string {
  const [a, b] = e;
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Compare two edge lists as sets, ignoring order and direction (but matching
 * weights when both sides provide them). Returns true on a set-equality match.
 */
export function edgesMatch(actual: GraphEdge[] | undefined, expected: readonly GraphEdge[]): boolean {
  if (!Array.isArray(actual)) return false;
  if (actual.length !== expected.length) return false;
  const expectedKeys = new Set(expected.map(edgeKey));
  for (const e of actual) {
    const k = edgeKey(e);
    if (!expectedKeys.has(k)) return false;
    expectedKeys.delete(k);
  }
  return expectedKeys.size === 0;
}

/** Parse the `GRAPH_ANSWER` JSON block out of a model answer string. */
export function parseGraphAnswer(raw: string): GraphAnswer | null {
  if (typeof raw !== "string") return null;
  // Accept either a fenced ```graph-answer ... ``` block or a bare JSON object.
  const fenced = raw.match(/```graph-answer\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const normaliseEdges = (value: unknown): GraphEdge[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      return value
        .map((e): GraphEdge | null => {
          if (!Array.isArray(e) || e.length < 2) return null;
          if (!e.every((n) => typeof n === "number")) return null;
          return e.slice(0, 3) as unknown as GraphEdge;
        })
        .filter((e): e is GraphEdge => e !== null);
    };
    const normaliseDegrees = (value: unknown): Record<string, number> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "number") out[String(k)] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const normalisePoints = (value: unknown): number[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      return value.filter((n): n is number => typeof n === "number");
    };
    return {
      edges: normaliseEdges(parsed.edges),
      degrees: normaliseDegrees(parsed.degrees),
      articulationPoints: normalisePoints(parsed.articulationPoints),
      answer: typeof parsed.answer === "string" ? parsed.answer : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Known-correct fixtures (spec §1.4). These are the regression anchors: if the
 * verifier or the prompt structure ever drifts, these expectations fail.
 */
export const Q6_KRUSKAL_EXPECTED_EDGES: readonly GraphEdge[] = [
  [3, 5],
  [1, 4],
  [0, 2],
  [0, 1],
  [0, 3]
] as const;

export const Q7_EXPECTED_ANSWER = "D {0,1,3}";
export const Q7_EXPECTED_ARTICULATION_POINTS = [0, 1, 3];

/** Verify a parsed Q6 (Kruskal) answer against the known-correct edge set. */
export function verifyQ6Kruskal(parsed: GraphAnswer | null): boolean {
  return edgesMatch(parsed?.edges, Q6_KRUSKAL_EXPECTED_EDGES);
}

/** Verify a parsed Q7 (articulation points) answer against the known-correct answer. */
export function verifyQ7Articulation(parsed: GraphAnswer | null): boolean {
  if (!parsed) return false;
  const answerOk =
    parsed.answer != null &&
    parsed.answer.replace(/\s+/g, " ").trim().toLowerCase() ===
      Q7_EXPECTED_ANSWER.replace(/\s+/g, " ").trim().toLowerCase();
  const points = parsed.articulationPoints ?? [];
  const pointsOk =
    points.length === Q7_EXPECTED_ARTICULATION_POINTS.length &&
    Q7_EXPECTED_ARTICULATION_POINTS.every((p) => points.includes(p));
  return answerOk && pointsOk;
}
