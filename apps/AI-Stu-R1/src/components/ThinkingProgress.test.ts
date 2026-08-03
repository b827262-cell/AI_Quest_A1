import { describe, expect, it } from "vitest";
import {
  estimateThinkingProgress,
  formatElapsedTime,
  formatProgressBar,
  getThinkingStage
} from "./ThinkingProgress";

describe("guest thinking progress estimate", () => {
  it("follows the 5/20/75/90/99 time anchors", () => {
    expect(estimateThinkingProgress(0)).toBe(5);
    expect(estimateThinkingProgress(10_000)).toBe(20);
    expect(estimateThinkingProgress(60_000)).toBe(75);
    expect(estimateThinkingProgress(90_000)).toBe(90);
    expect(estimateThinkingProgress(150_000)).toBe(99);
    expect(estimateThinkingProgress(180_000)).toBe(99);
  });

  it("maps percentages to the requested processing stages", () => {
    expect(getThinkingStage(5)).toBe("正在讀取題目");
    expect(getThinkingStage(30)).toBe("正在分析解題方向");
    expect(getThinkingStage(65)).toBe("正在產生完整答案");
    expect(getThinkingStage(90)).toBe("正在整理答案格式");
    expect(getThinkingStage(100)).toBe("答案完成");
  });

  it("formats elapsed time and the visual block bar", () => {
    expect(formatElapsedTime(65_432)).toBe("01:05");
    expect(formatProgressBar(68, 22)).toBe("███████████████░░░░░░░");
  });
});
