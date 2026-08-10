/**
 * Chunk planning and the resident-memory budget — pure, no IPC (V03-S5, D-055).
 *
 * `schedulePlan.ts` decides *when* samples should sound. This module decides *which*
 * samples to have in memory at all, and — the harder half — which to throw away.
 *
 * ## The numbers, and why they are these numbers
 *
 * A chunk is 15 s of mono f32 at 12 kHz: 180 000 samples, **720 KB**. Small enough that
 * fetching one is not a visible stall even off a NAS; large enough that a two-hour
 * service is 480 chunks rather than tens of thousands of round trips.
 *
 * The horizon is **30 s ahead / 15 s behind** the playhead. Ahead is prefetch: a second's
 * worth would leave nothing between a slow read and a dropout. Behind is not prefetch at
 * all — it is what makes nudging the playhead back a few seconds (the actual gesture for
 * "wait, was that in sync?") instant instead of another round of fetching.
 *
 * The budget is **256 MB** — 372 chunks, about 93 minutes of a single clip, or 15 minutes
 * with six cameras rolling. It exists because the alternative is not "a bit more memory":
 * an eight-camera three-hour shoot is 4.2 GB of analysis audio, and a renderer that keeps
 * all of it is a renderer that gets killed mid-service.
 */

import {
  CHUNK_BYTES,
  CHUNK_SAMPLES,
  chunkCount,
  chunkTimelineSpan,
  clipTransport,
  type PlacedClip,
  type ScheduleOptions,
} from "./schedulePlan";

export { CHUNK_BYTES, CHUNK_SAMPLES };

/** Global ceiling on resident PCM. */
export const BUDGET_BYTES = 256 * 1024 * 1024;

/** Default prefetch horizon ahead of the playhead, seconds. */
export const AHEAD_SEC = 30;

/** Default retention behind the playhead, seconds. */
export const BEHIND_SEC = 15;

/** One chunk of one file. */
export interface ChunkRef {
  file: string;
  chunkIndex: number;
}

/** `file#index` — the key both the store and the scheduler index chunks by. */
export function chunkKey(file: string, chunkIndex: number): string {
  return `${file}#${chunkIndex}`;
}

/** How many chunks fit in the budget. */
export function chunkCapacity(budgetBytes: number = BUDGET_BYTES): number {
  return Math.max(1, Math.floor(budgetBytes / CHUNK_BYTES));
}

export interface PlanOptions extends ScheduleOptions {
  aheadSec?: number;
  behindSec?: number;
  budgetBytes?: number;
}

/**
 * Every chunk that should be resident if the playhead is at `tSec`, **nearest first**.
 *
 * The order is the fetch order, and it is the whole of the priority policy: the chunk the
 * ear needs in two seconds is fetched before the one it needs in twenty-eight. Distance is
 * measured from the playhead to the nearest edge of the chunk's timeline span, so the
 * chunk the playhead is standing in always sorts first.
 *
 * Capped at the budget's capacity. That cap can only bind with dozens of simultaneous
 * clips, but "plan more than can be held" is how a cache starts thrashing, and thrashing
 * sounds like dropouts nobody can explain.
 */
export function planChunks(clips: PlacedClip[], tSec: number, opts: PlanOptions): ChunkRef[] {
  const ahead = opts.aheadSec ?? AHEAD_SEC;
  const behind = opts.behindSec ?? BEHIND_SEC;
  const from = tSec - behind;
  const to = tSec + ahead;

  const scored: { ref: ChunkRef; distance: number }[] = [];
  for (const clip of clips) {
    const t = clipTransport(clip, opts);
    if (t.sourceSamples <= 0) continue;
    if (t.endSec <= from || t.startSec >= to) continue;

    const total = chunkCount(t.sourceSamples);
    for (let k = 0; k < total; k += 1) {
      const span = chunkTimelineSpan(t, k);
      if (span.endSec <= from) continue;
      if (span.startSec >= to) break; // chunks are ordered in time; so is every later one
      scored.push({
        ref: { file: clip.file, chunkIndex: k },
        distance: distanceToSpan(tSec, span.startSec, span.endSec),
      });
    }
  }

  scored.sort(
    (a, b) =>
      a.distance - b.distance ||
      (a.ref.file < b.ref.file ? -1 : a.ref.file > b.ref.file ? 1 : 0) ||
      a.ref.chunkIndex - b.ref.chunkIndex,
  );
  return scored.slice(0, chunkCapacity(opts.budgetBytes)).map((s) => s.ref);
}

/** 0 inside the span, otherwise the gap to its nearest edge. */
export function distanceToSpan(tSec: number, startSec: number, endSec: number): number {
  if (tSec < startSec) return startSec - tSec;
  if (tSec > endSec) return tSec - endSec;
  return 0;
}

/** A chunk currently held in memory, with what eviction needs to judge it. */
export interface ResidentChunk extends ChunkRef {
  /** Timeline second the chunk's audio starts at (from `chunkTimelineSpan`). */
  startSec: number;
  /** Timeline second it ends at. */
  endSec: number;
  /** Monotonic counter, bumped whenever the chunk is used. Breaks distance ties. */
  lastUsedSeq: number;
  /** Actual bytes held (a short final chunk costs less than a full one). */
  bytes: number;
}

/**
 * Which resident chunks to drop so the plan fits the budget.
 *
 * **Eviction order is farthest-from-playhead first**, with least-recently-used as the
 * tie-break. Distance leads rather than pure LRU because playback is a *sweep*, not a
 * random-access workload: under pure LRU the chunk evicted to make room for the next
 * second of audio can easily be the one four seconds behind the playhead — precisely the
 * one a nudge backwards is about to want — while a chunk from a clip the playhead left ten
 * minutes ago survives because it happened to be touched more recently. Recency only
 * decides between two chunks the playhead is equally far from, where it is exactly right:
 * the one that has sat untouched longer is the one nothing is using.
 *
 * Chunks in `keep` are never evicted; they are what is about to play.
 */
export function chooseEvictions(
  resident: ResidentChunk[],
  keep: ChunkRef[],
  tSec: number,
  budgetBytes: number = BUDGET_BYTES,
): ChunkRef[] {
  const keepKeys = new Set(keep.map((r) => chunkKey(r.file, r.chunkIndex)));

  let held = 0;
  const evictable: ResidentChunk[] = [];
  for (const c of resident) {
    held += c.bytes;
    if (!keepKeys.has(chunkKey(c.file, c.chunkIndex))) evictable.push(c);
  }

  // Room must be left for the chunks that are planned but not yet here, or the store
  // fetches them and immediately blows the budget it was supposed to respect.
  const residentKeys = new Set(resident.map((c) => chunkKey(c.file, c.chunkIndex)));
  const incoming = keep.filter((r) => !residentKeys.has(chunkKey(r.file, r.chunkIndex))).length;
  const target = budgetBytes - incoming * CHUNK_BYTES;

  if (held <= target) return [];

  evictable.sort((a, b) => {
    const da = distanceToSpan(tSec, a.startSec, a.endSec);
    const db = distanceToSpan(tSec, b.startSec, b.endSec);
    return db - da || a.lastUsedSeq - b.lastUsedSeq;
  });

  const out: ChunkRef[] = [];
  for (const c of evictable) {
    if (held <= target) break;
    held -= c.bytes;
    out.push({ file: c.file, chunkIndex: c.chunkIndex });
  }
  return out;
}
