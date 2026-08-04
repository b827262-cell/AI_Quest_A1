export interface RankedListItem<T> {
  id: string;
  value: T;
}

export interface FusedRankItem<T> extends RankedListItem<T> {
  score: number;
  ranks: Record<string, number>;
}

/**
 * Fuse heterogeneous rankings without comparing incompatible raw scores.
 * Rank positions are one-based, following the standard RRF definition.
 */
export function reciprocalRankFusion<T>(
  rankings: Readonly<Record<string, readonly RankedListItem<T>[]>>,
  rankConstant = 60,
): FusedRankItem<T>[] {
  if (!Number.isFinite(rankConstant) || rankConstant <= 0) {
    throw new RangeError("rankConstant must be a positive finite number");
  }

  const fused = new Map<string, FusedRankItem<T>>();

  for (const [rankingName, items] of Object.entries(rankings)) {
    const seenInRanking = new Set<string>();

    items.forEach((item, index) => {
      if (seenInRanking.has(item.id)) {
        return;
      }
      seenInRanking.add(item.id);

      const rank = index + 1;
      const contribution = 1 / (rankConstant + rank);
      const existing = fused.get(item.id);

      if (existing) {
        existing.score += contribution;
        existing.ranks[rankingName] = rank;
        return;
      }

      fused.set(item.id, {
        id: item.id,
        value: item.value,
        score: contribution,
        ranks: { [rankingName]: rank },
      });
    });
  }

  return [...fused.values()].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
}
