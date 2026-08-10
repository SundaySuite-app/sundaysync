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
 * identity the timeline already keys its clip buttons on. Callers derive
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

// `trackAtY` (y → the sub-track row under it) came across from SundayEdit with
// `stackClips` and was removed in V03-S6 (finding 15). Nothing ever called it: S3 puts a
// real DOM node under every clip so hit-testing is the browser's job, and S5's playback
// addresses clips by file, not by where they sit on screen. Tested, exported, dead — and
// dead code with tests reads as load-bearing to the next person. If a future gesture needs
// it (a lasso, a drag-to-reorder), it is four lines and it is in the history.
