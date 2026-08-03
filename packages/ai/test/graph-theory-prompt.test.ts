import { describe, expect, it } from "vitest";
import {
  GUEST_ASK_SYSTEM_PROMPT,
  GRAPH_THEORY_TUTOR_SYSTEM_PROMPT,
  GRAPH_THEORY_KEYWORDS,
  isGraphTheoryQuestion,
  selectGuestSystemPrompt
} from "../src/prompts/guest-ask.prompt";
import {
  parseGraphAnswer,
  edgesMatch,
  verifyQ6Kruskal,
  verifyQ7Articulation,
  Q6_KRUSKAL_EXPECTED_EDGES,
  Q7_EXPECTED_ANSWER,
  Q7_EXPECTED_ARTICULATION_POINTS
} from "../src/prompts/graph-answer";

describe("graph-theory prompt + answer verification (spec §1, §1.4)", () => {
  it("includes the no-fabrication rule in the base prompt", () => {
    expect(GUEST_ASK_SYSTEM_PROMPT).toMatch(/虛構|不得自行/);
    expect(GUEST_ASK_SYSTEM_PROMPT).toMatch(/上下文/);
  });

  it("graph prompt enforces edge-list-first, then degrees, then articulation", () => {
    expect(GRAPH_THEORY_TUTOR_SYSTEM_PROMPT).toMatch(/列出實際選中的邊/);
    expect(GRAPH_THEORY_TUTOR_SYSTEM_PROMPT).toMatch(/各頂點的 Degree|Degree/);
    expect(GRAPH_THEORY_TUTOR_SYSTEM_PROMPT).toMatch(/articulation points|割點/);
    // Must forbid rewriting the given edge set.
    expect(GRAPH_THEORY_TUTOR_SYSTEM_PROMPT).toMatch(/不得自行改寫/);
    // Emits a parseable GRAPH_ANSWER block.
    expect(GRAPH_THEORY_TUTOR_SYSTEM_PROMPT).toMatch(/GRAPH_ANSWER/);
  });

  it("detects graph-theory questions in EN and zh-Hant", () => {
    expect(isGraphTheoryQuestion("Find the MST using Kruskal's algorithm")).toBe(true);
    expect(isGraphTheoryQuestion("求下圖的最小生成樹")).toBe(true);
    expect(isGraphTheoryQuestion("列出所有 articulation points")).toBe(true);
    expect(isGraphTheoryQuestion("What is the capital of France?")).toBe(false);
  });

  it("keeps the internal graph contract out of guest prompts", () => {
    expect(selectGuestSystemPrompt("Use Kruskal to find the MST")).toBe(GUEST_ASK_SYSTEM_PROMPT);
    expect(selectGuestSystemPrompt("hello world")).toBe(GUEST_ASK_SYSTEM_PROMPT);
  });

  // ----- Question 6: Kruskal edge selection (spec §1.4) --------------------
  it("Q6 Kruskal expected edge set is the spec anchor", () => {
    // The regression anchor: the verifier recognises exactly this set.
    expect(Q6_KRUSKAL_EXPECTED_EDGES.map((e) => `[${e[0]},${e[1]}]`).join(",")).toBe(
      "[3,5],[1,4],[0,2],[0,1],[0,3]"
    );
  });

  it("verifyQ6Kruskal accepts the correct edges (order/direction-independent)", () => {
    // A model answer emitted in a different order / direction must still match.
    const answerText = "```graph-answer\n" +
      JSON.stringify({
        edges: [
          [5, 3],
          [4, 1, 2],
          [2, 0],
          [1, 0],
          [3, 0]
        ]
      }) +
      "\n```";
    const parsed = parseGraphAnswer(answerText);
    expect(verifyQ6Kruskal(parsed)).toBe(true);
  });

  it("verifyQ6Kruskal rejects a wrong edge set", () => {
    const parsed = parseGraphAnswer(
      "```graph-answer\n" + JSON.stringify({ edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]] }) + "\n```"
    );
    expect(verifyQ6Kruskal(parsed)).toBe(false);
  });

  it("edgesMatch treats [u,v] and [v,u] as equal", () => {
    expect(edgesMatch([[1, 2]], [[2, 1]])).toBe(true);
    expect(edgesMatch([[1, 2], [3, 4]], [[4, 3], [2, 1]])).toBe(true);
    expect(edgesMatch([[1, 2]], [[1, 3]])).toBe(false);
  });

  // ----- Question 7: articulation points (spec §1.4) -----------------------
  it("Q7 expected answer and articulation points are the spec anchor", () => {
    expect(Q7_EXPECTED_ANSWER).toBe("D {0,1,3}");
    expect(Q7_EXPECTED_ARTICULATION_POINTS).toEqual([0, 1, 3]);
  });

  it("verifyQ7Articulation accepts the correct answer", () => {
    const parsed = parseGraphAnswer(
      "```graph-answer\n" +
        JSON.stringify({ answer: "D {0,1,3}", articulationPoints: [3, 1, 0] }) +
        "\n```"
    );
    expect(verifyQ7Articulation(parsed)).toBe(true);
  });

  it("verifyQ7Articulation rejects a wrong multiple-choice answer", () => {
    const parsed = parseGraphAnswer(
      "```graph-answer\n" + JSON.stringify({ answer: "B {0,2}", articulationPoints: [0, 2] }) + "\n```"
    );
    expect(verifyQ7Articulation(parsed)).toBe(false);
  });

  it("parseGraphAnswer tolerates a bare JSON object (no fence)", () => {
    const parsed = parseGraphAnswer(JSON.stringify({ edges: [[0, 1]], answer: "A {0}" }));
    expect(parsed?.edges?.length).toBe(1);
    expect(parsed?.answer).toBe("A {0}");
  });

  it("parseGraphAnswer returns null on garbage", () => {
    expect(parseGraphAnswer("nothing useful here")).toBeNull();
    expect(parseGraphAnswer("")).toBeNull();
  });
});
