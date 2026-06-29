import type { KnowledgePoint } from "./studentClient";

export type AchievementPoint = KnowledgePoint & {
  bookId?: string;
  completedAt?: string | null;
};

export interface AchievementSummary {
  bookId: string;
  completedKnowledgePointsCount: number;
  totalKnowledgePointsCount: number;
  completionPercentage: number;
  latestCompletedPoint: AchievementPoint | null;
  milestoneText: string;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Build a learning achievement summary from knowledge points.
 *
 * The existing Knowledge Points API does not expose `completedAt` yet, so the
 * MVP returns `latestCompletedPoint = null` unless the caller provides points
 * with that field attached.
 */
export function buildAchievementSummary(
  points: readonly AchievementPoint[],
  bookId = ""
): AchievementSummary {
  const resolvedBookId =
    bookId ||
    points.find((point) => typeof point.bookId === "string" && point.bookId.trim().length > 0)
      ?.bookId ||
    "";
  const totalKnowledgePointsCount = points.length;
  const completedPoints = points.filter((point) => point.status === "completed");
  const completedKnowledgePointsCount = completedPoints.length;
  const completionPercentage =
    totalKnowledgePointsCount > 0
      ? Math.round((completedKnowledgePointsCount / totalKnowledgePointsCount) * 100)
      : 0;

  let latestCompletedPoint: AchievementPoint | null = null;
  let latestCompletedAt = -1;
  for (const point of completedPoints) {
    const completedAt = parseTimestamp(point.completedAt);
    if (completedAt == null || completedAt <= latestCompletedAt) continue;
    latestCompletedAt = completedAt;
    latestCompletedPoint = point;
  }

  return {
    bookId: resolvedBookId,
    completedKnowledgePointsCount,
    totalKnowledgePointsCount,
    completionPercentage,
    latestCompletedPoint,
    milestoneText:
      totalKnowledgePointsCount > 0
        ? `已完成 ${completedKnowledgePointsCount} / ${totalKnowledgePointsCount} 個知識點`
        : "此書尚無知識點"
  };
}
