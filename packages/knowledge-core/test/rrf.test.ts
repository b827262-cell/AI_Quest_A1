import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "../src/rrf.js";

describe("reciprocalRankFusion", () => {
  it("rewards artifacts that appear in multiple rankings", () => {
    const result = reciprocalRankFusion(
      {
        dense: [
          { id: "a", value: "A" },
          { id: "b", value: "B" },
        ],
        lexical: [
          { id: "b", value: "B" },
          { id: "c", value: "C" },
        ],
      },
      60,
    );

    expect(result.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(result[0]?.ranks).toEqual({ dense: 2, lexical: 1 });
  });

  it("ignores duplicate IDs inside one ranking", () => {
    const result = reciprocalRankFusion(
      {
        dense: [
          { id: "a", value: "first" },
          { id: "a", value: "duplicate" },
        ],
      },
      10,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("first");
    expect(result[0]?.score).toBeCloseTo(1 / 11);
  });

  it("rejects invalid rank constants", () => {
    expect(() => reciprocalRankFusion({}, 0)).toThrow(RangeError);
    expect(() => reciprocalRankFusion({}, Number.NaN)).toThrow(RangeError);
  });
});
