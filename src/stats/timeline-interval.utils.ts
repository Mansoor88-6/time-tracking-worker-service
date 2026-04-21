/**
 * Wall-clock interval helpers for productivity timeline slots (5-minute buckets).
 */

export type MsInterval = { startMs: number; endMs: number };

/** Merge overlapping or adjacent intervals (sorted by start). */
export function mergeMsIntervals(intervals: MsInterval[]): MsInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: MsInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (!last || cur.startMs > last.endMs) {
      out.push({ ...cur });
    } else {
      last.endMs = Math.max(last.endMs, cur.endMs);
    }
  }
  return out;
}

/**
 * Subtract `toRemove` from `base` (set difference `base \ toRemove`).
 *
 * Used by slot aggregation so a later-inserted synthetic `__offline_approval__`
 * active event (which shares wall-clock with the original idle it came from)
 * doesn't leave a phantom idle contribution on top. Pieces shorter than ~1ms
 * are dropped by `complementInRange`.
 */
export function subtractMsIntervals(
  base: MsInterval[],
  toRemove: MsInterval[],
): MsInterval[] {
  if (base.length === 0) return [];
  if (toRemove.length === 0) return mergeMsIntervals(base);
  const mergedBase = mergeMsIntervals(base);
  const mergedRemove = mergeMsIntervals(toRemove);
  const out: MsInterval[] = [];
  for (const b of mergedBase) {
    out.push(...complementInRange(b.startMs, b.endMs, mergedRemove));
  }
  return mergeMsIntervals(out);
}

/**
 * Gaps in [rangeStart, rangeEnd) not covered by `coveredInput`.
 * Input need not be pre-merged. Gaps shorter than ~1ms are dropped.
 */
export function complementInRange(
  rangeStart: number,
  rangeEnd: number,
  coveredInput: MsInterval[],
): MsInterval[] {
  const merged = mergeMsIntervals(coveredInput);
  if (merged.length === 0) {
    if (rangeEnd - rangeStart <= 1) return [];
    return [{ startMs: rangeStart, endMs: rangeEnd }];
  }
  let cur = rangeStart;
  const out: MsInterval[] = [];
  for (const iv of merged) {
    if (iv.startMs > cur) {
      const end = Math.min(iv.startMs, rangeEnd);
      if (end - cur > 1) out.push({ startMs: cur, endMs: end });
    }
    cur = Math.max(cur, iv.endMs);
    if (cur >= rangeEnd) break;
  }
  if (cur < rangeEnd && rangeEnd - cur > 1) {
    out.push({ startMs: cur, endMs: rangeEnd });
  }
  return mergeMsIntervals(out);
}
