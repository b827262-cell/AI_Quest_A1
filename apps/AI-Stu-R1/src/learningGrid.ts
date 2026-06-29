import type { BookChapter } from "@ai-smartbook/schema";
import type { KnowledgePoint, KnowledgePointStatus } from "./studentClient";

export type LearningGridPoint = KnowledgePoint;

export type LearningGridCellStatus = KnowledgePointStatus | "empty";

export interface LearningGridCell {
  cellIndex: number;
  row: number;
  col: number;
  status: LearningGridCellStatus;
  point: LearningGridPoint | null;
}

const DEFAULT_FALLBACK_SUMMARY = "本章重點待整理";

/**
 * Build a fixed-size square grid in row-major order.
 *
 * The caller supplies already-normalized learning points. The grid always
 * returns size * size cells, with any overflow points ignored and missing
 * cells filled with `empty`.
 */
export function buildLearningGridCells(
  points: readonly LearningGridPoint[],
  size = 5
): LearningGridCell[] {
  const gridSize = Number.isFinite(size) && size > 0 ? Math.max(1, Math.floor(size)) : 5;
  const totalCells = gridSize * gridSize;
  const limitedPoints = points.slice(0, totalCells);

  return Array.from({ length: totalCells }, (_, index) => {
    const point = limitedPoints[index] ?? null;
    return {
      cellIndex: index + 1,
      row: Math.floor(index / gridSize) + 1,
      col: (index % gridSize) + 1,
      status: point == null ? "empty" : point.status === "completed" ? "completed" : "available",
      point
    };
  });
}

/**
 * Convert chapters into knowledge-point-shaped fallback data when the API
 * returns no dedicated knowledge points yet.
 */
export function buildLearningGridPointsFromChapters(
  chapters: readonly BookChapter[]
): LearningGridPoint[] {
  return chapters
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((chapter): LearningGridPoint => ({
      id: `kp_${chapter.id}`,
      chapterId: chapter.id,
      title: chapter.title.trim(),
      summary: chapter.summary?.trim() || DEFAULT_FALLBACK_SUMMARY,
      sourcePageStart: chapter.pageStart ?? null,
      sourcePageEnd: chapter.pageEnd ?? null,
      importance: "medium",
      difficulty: "basic",
      status: "available"
    }));
}
