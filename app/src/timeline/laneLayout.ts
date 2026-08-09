// Adapted from SundayEdit (same owner) — src/features/timeline/laneLayout.ts; see docs/DECISIONS.md D-051.

/**
 * Pure multi-row layout math for one device's lane (v0.3, D-051). §4.4's
 * same-device eviction (D-050) means most placements on one device never
 * overlap in time — but the multitrack-dump exemption and near-miss
 * `device_overlap` cases can still leave two or more clips on the same
 * device covering the same instant. `stackClips` packs those into separate
 * sub-rows so every clip stays visible instead of one hiding behind another.
 *
 * Kept free of React so the packing algorithm is unit-tested in isolation,
 * exactly like `geometry.ts`.
 */

/**
 * A clip's placement on the timeline, in timeline-ms. `file` is the same
 * identity `ResultView` already keys its clip buttons on. Callers derive
 * `startMs`/`endMs` from `Placement.offset_seconds` and the file's duration
 * (`SyncOutcome.durations`) — this module has no opinion on where those
 * numbers come from.
 */
export interface ClipSpan {
  file: string;
  startMs: number;
  endMs: number;
}

/**
 * Greedy first-fit-by-row interval packing: sort by `startMs`, then place
 * each clip in the first row whose last clip already ends at or before this
 * clip's start (creating a new row when none does). Touching endpoints
 * (`endMs === startMs`) do NOT count as overlapping, so a clip may start
 * exactly when the previous one ends and still share its row. Deterministic:
 * ties in `startMs` keep their relative input order (stable sort).
 */
export function stackClips(clips: ClipSpan[]): ClipSpan[][] {
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
  const rows: ClipSpan[][] = [];
  for (const clip of sorted) {
    const row = rows.find((r) => r[r.length - 1].endMs <= clip.startMs);
    if (row) {
      row.push(clip);
    } else {
      rows.push([clip]);
    }
  }
  return rows;
}

/**
 * The row a vertical offset lands on within one device's stacked lane. `y`
 * is measured from the top of that device's lane (i.e. below its label).
 * Returns the row (so callers can read every clip sharing it) or null when
 * outside every row.
 */
export function trackAtY(
  y: number,
  rows: ClipSpan[][],
  rowH: number,
): ClipSpan[] | null {
  if (rowH <= 0 || y < 0) return null;
  const i = Math.floor(y / rowH);
  return i < rows.length ? rows[i] : null;
}
