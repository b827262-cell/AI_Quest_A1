import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  estimateThinkingProgress,
  formatElapsedTime,
  formatProgressBar,
  getThinkingStage,
  ThinkingProgress
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

  it.each([15, 68, 99, 100])("renders the complete compact fixture at %i%%", (progress) => {
    const markup = renderToStaticMarkup(createElement(ThinkingProgress, {
      progress,
      elapsedMs: 65_000,
      onCancel: vi.fn()
    }));

    expect(markup).toContain(`data-thinking-progress="${progress}"`);
    expect(markup).toContain("AI-SmartBook");
    expect(markup).toContain("拼圖大腦預估完成度");
    expect(markup).toContain("thinking-particles");
    expect(markup).toContain("AI 思考中");
    expect(markup).toContain(progress === 100 ? "答案已完成，正在開啟" : "正在整理答案，請稍候");
    expect(markup).toContain(`${progress}<span>%</span>`);
    expect(markup).toContain("thinking-progress-track");
    expect(markup).toContain("小提醒");
    expect(markup).toContain(getThinkingStage(progress));
    expect(markup).toContain("已經過 01:05");
    if (progress < 100) expect(markup).toContain("停止解題");
    else expect(markup).not.toContain("停止解題");
  });

  it("uses a native 320 by 200 layout without scaling the old card", () => {
    const css = readFileSync(new URL("./ThinkingProgress.css", import.meta.url), "utf8");

    expect(css).toContain("width: min(320px, calc(100vw - 24px));");
    expect(css).toContain("height: 200px;");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).not.toMatch(/transform\s*:\s*[^;]*scale\s*\(/i);
    expect(css).not.toContain("1248px");
    expect(css).not.toContain("704px");
  });
});
