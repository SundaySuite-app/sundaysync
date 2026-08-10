// Draw-loop structure (one pass, peak outline behind an RMS body) adapted from Clypra's
// `drawProfessionalWaveform` (src/lib/utils/canvasUtils.ts) — see docs/DECISIONS.md D-053,
// which flagged this as "planned (S4)". THIRD-PARTY-NOTICES carries Clypra's MIT text.
// SundaySync's version differs in the particulars: bars are drawn symmetric around the
// clip's vertical centre (peak *and* RMS, not RMS-as-peak-substitute) and the bucket
// count/positions come from S2's on-disk pyramid rather than a buffer resampled to a
// fixed count, but the "one sequential pass over pre-computed buckets" shape is theirs.

/**
 * Pure geometry for drawing a clip's waveform (v0.3 S4) — level selection and the
 * time↔bin↔pixel mapping that decides which bytes to fetch and where to put them on
 * screen. Kept free of the Canvas API and of React for the same reason as its neighbours
 * in this directory: the tricky arithmetic is unit-tested in isolation, and
 * `WaveformCanvas.tsx` is left with nothing harder than a loop over the numbers here.
 */

import type { TimelineView } from "./geometry";

/** The shape `waveform_meta` answers with — see `app/src/types.ts` `WaveformMeta`. Redeclared
 *  narrowly here (structural typing) so this module does not have to import the wider
 *  contract file just for two field names. */
export interface Level {
  binSamples: number;
  bins: number;
}

export interface WaveformMetaShape {
  totalSamples: number;
  levels: Level[];
}

/**
 * Mirrors `crates/core/src/request.rs` `ANALYSIS_RATE` — every clip's peak pyramid is
 * built at this one fixed rate (crates/core/src/peaks.rs: "Level 0 bins 120 samples =
 * 10 ms at 12 kHz"), so a level's bin duration depends only on its index, never on the
 * file. Used *only* for level selection (`pickLevel`); the actual bin→time mapping for
 * drawing (`barGeometry`) deliberately does not use this constant — it derives bin
 * duration from `totalSamples` and the clip's own drawn width instead, so the waveform
 * always exactly fills the box `TimelineView` drew, even if ffprobe's duration and the
 * analysis cache's sample count disagree by a few milliseconds.
 */
export const ANALYSIS_RATE_HZ = 12_000;

/** How long one bin of `level` spans, in ms, at the fixed analysis rate. */
export function binDurationMs(level: Level): number {
  return (level.binSamples / ANALYSIS_RATE_HZ) * 1000;
}

/**
 * How many bins of `level` land on one screen pixel at `pxPerMs`. >1 means bins are
 * being crammed together (wasted detail, more bytes to fetch than pixels to show it on);
 * <1 means one bin is stretched across several pixels (blocky, but unavoidable once the
 * finest level is already coarser than the display).
 */
function binsPerPx(level: Level, pxPerMs: number): number {
  const pxPerBin = binDurationMs(level) * pxPerMs;
  return pxPerBin > 0 ? 1 / pxPerBin : Infinity;
}

/** Above this many bins per pixel, a level buys nothing visible and only costs bytes —
 *  time to step to the next-coarser level. The target band is 1–2 bins/px. */
const MAX_BINS_PER_PX = 2;

/**
 * The finest (smallest-index) level whose bins/px does not exceed `MAX_BINS_PER_PX` —
 * i.e. the most detail the display can actually show without redundant reads. Scans from
 * level 0 (finest) upward, so a clip zoomed in past the finest level's own resolution
 * simply gets level 0 (there is nothing finer to give it — "blocky" is the ceiling, not a
 * bug). A clip zoomed out past the coarsest level's resolution gets the coarsest level
 * (index `levels.length - 1`) — the closest available, not a crash.
 *
 * Returns `-1` for an empty ladder — callers treat that as "nothing to draw", the same
 * state as any other geometry input that yields no visible bins.
 */
export function pickLevel(levels: Level[], pxPerMs: number): number {
  if (levels.length === 0) return -1;
  for (let i = 0; i < levels.length; i++) {
    if (binsPerPx(levels[i], pxPerMs) <= MAX_BINS_PER_PX) return i;
  }
  return levels.length - 1;
}

/** A clip's own extent, in timeline ms — the same shape `laneLayout.ts`'s `ClipSpan`
 *  carries the position in (file omitted; geometry here has no use for it). */
export interface ClipExtent {
  startMs: number;
  endMs: number;
}

/**
 * Everything `WaveformCanvas` needs to size itself and draw: which level to fetch, which
 * bins of it are visible, and exactly where each one's bar goes.
 *
 * Two coordinate systems on purpose:
 *   - `leftCssPx`/`widthCssPx` are CSS pixels, clip-local (0 = the clip box's own left
 *     edge) — what positions the `<canvas>` element inside `.clip__waveform`.
 *   - `xs`/`barWidthPx` are DEVICE pixels, CANVAS-local (0 = that positioned canvas's own
 *     left edge) — what the draw loop hands straight to `fillRect` against the DPR-scaled
 *     backing store, no further arithmetic needed at the call site.
 */
export interface BarGeometry {
  level: number;
  binStart: number;
  binCount: number;
  /** Device-px left edge of each bin's bar, canvas-local. `length === binCount`. */
  xs: number[];
  /** Device-px width of one bin's bar. Bars are drawn contiguous (abutting), not
   *  centred-with-gaps, so `xs[i+1] - xs[i] === barWidthPx` up to rounding. */
  barWidthPx: number;
  leftCssPx: number;
  widthCssPx: number;
}

/**
 * The clip's own box in timeline pixels, intersected with the viewport — the "only the
 * visible slice, never the full zoomed width" rule a 60-minute clip at high zoom needs.
 * `null` when the clip has nothing on-screen right now (fully scrolled out either side).
 */
function visibleWindow(
  span: ClipExtent,
  view: TimelineView,
): { clipLeftPx: number; clipWidthPx: number; startPx: number; endPx: number } | null {
  const durationMs = span.endMs - span.startMs;
  if (durationMs <= 0) return null;
  const clipLeftPx = (span.startMs - view.scrollMs) * view.pxPerMs;
  const clipWidthPx = durationMs * view.pxPerMs;
  const startPx = Math.max(0, -clipLeftPx);
  const endPx = Math.min(clipWidthPx, view.widthPx - clipLeftPx);
  if (endPx <= startPx) return null;
  return { clipLeftPx, clipWidthPx, startPx, endPx };
}

/**
 * Maps a clip's visible slice onto one level of its waveform pyramid, in both the CSS-px
 * (canvas placement) and device-px (draw loop) coordinate systems `dpr` scales between.
 *
 * `meta.totalSamples` is trusted as the authority on how the clip's samples map onto its
 * drawn width — `span`'s own `endMs - startMs` (not any external duration figure) is what
 * "the whole clip" means here, so the waveform always fills exactly the box already on
 * screen even if the source duration measurements disagree by a few ms (D-052 notes the
 * analysis cache and ffprobe can).
 *
 * Returns `null` when there is nothing to draw: no visible slice, an empty ladder, a
 * degenerate (zero-sample) file, or a level with no bins.
 */
export function barGeometry(
  span: ClipExtent,
  meta: WaveformMetaShape,
  view: TimelineView,
  dpr: number,
): BarGeometry | null {
  if (meta.totalSamples <= 0) return null;
  const win = visibleWindow(span, view);
  if (!win) return null;

  const level = pickLevel(meta.levels, view.pxPerMs);
  if (level < 0) return null;
  const lvl = meta.levels[level];
  if (lvl.bins <= 0) return null;

  const durationMs = span.endMs - span.startMs;
  const samplesPerMs = meta.totalSamples / durationMs;
  const samplesPerCssPx = samplesPerMs / view.pxPerMs;

  const startSample = win.startPx * samplesPerCssPx;
  const endSample = win.endPx * samplesPerCssPx;

  const binStart = Math.min(lvl.bins, Math.max(0, Math.floor(startSample / lvl.binSamples)));
  const binEnd = Math.min(lvl.bins, Math.max(binStart, Math.ceil(endSample / lvl.binSamples)));
  const binCount = binEnd - binStart;
  if (binCount <= 0) return null;

  // One bin's CSS-px width, then its bar's device-px width — constant across the level's
  // bins (evenly spaced), so this is computed once rather than per bin.
  const binWidthCssPx = (lvl.binSamples / meta.totalSamples) * durationMs * view.pxPerMs;
  const barWidthPx = Math.max(1, binWidthCssPx * dpr);

  const xs: number[] = new Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const binIndex = binStart + i;
    const binStartSample = binIndex * lvl.binSamples;
    const binStartMsInClip = (binStartSample / meta.totalSamples) * durationMs;
    const binStartCssPxInClip = binStartMsInClip * view.pxPerMs;
    xs[i] = (binStartCssPxInClip - win.startPx) * dpr;
  }

  return {
    level,
    binStart,
    binCount,
    xs,
    barWidthPx,
    leftCssPx: win.startPx,
    widthCssPx: win.endPx - win.startPx,
  };
}
