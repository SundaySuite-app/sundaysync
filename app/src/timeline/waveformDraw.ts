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
 * file.
 *
 * **This constant is the ONLY thing that maps a bin to a time** — both for level
 * selection (`pickLevel`) and for the drawn position of every bar (`barGeometry`).
 * D-054 originally derived the drawn mapping from `totalSamples` and the clip's own box
 * width instead, so that the waveform "always exactly fills the box"; D-056 reverses
 * that, because the two numbers measure different things. `span.endMs - span.startMs`
 * comes from ffprobe's *container* duration (`probe.rs` → `SyncOutcome.durations`) while
 * `totalSamples` is the decoded length of the first audio stream in the `.f32` cache
 * (`extract.rs`, no `-t`, no padding). AAC priming, edit lists, frame-rounded container
 * durations and audio that simply ends before the video all make them disagree — by
 * hundreds of milliseconds on a service-length clip — and stretching the waveform to
 * close that gap warps every bar in the middle of the clip too, by up to half the
 * discrepancy. Each device warps by a different amount, so correctly-synced clips end up
 * *looking* misaligned, which is fatal for a view whose entire job is judging alignment
 * by eye.
 *
 * The invariant is therefore: **the waveform is anchored to real time; the clip box is
 * the container's duration, and the two may legitimately disagree at the tail.** A
 * shorter analysis leaves the last few pixels of the box unpainted; a longer one is
 * clipped at the box's edge. Both are honest.
 */
export const ANALYSIS_RATE_HZ = 12_000;

/** How long one bin of `level` spans, in ms, at the fixed analysis rate. */
export function binDurationMs(level: Level): number {
  return (level.binSamples / ANALYSIS_RATE_HZ) * 1000;
}

/**
 * How many bins of `level` land on one pixel at `pxPerPx`. >1 means bins are being
 * crammed together (wasted detail, more bytes to fetch than pixels to show it on); <1
 * means one bin is stretched across several pixels (blocky, but unavoidable once the
 * finest level is already coarser than the display).
 *
 * The pixel here is whatever the caller measures in — `pickLevel` is always fed DEVICE
 * pixels per ms (see its own note), never CSS pixels.
 */
function binsPerPx(level: Level, pxPerMs: number): number {
  const pxPerBin = binDurationMs(level) * pxPerMs;
  return pxPerBin > 0 ? 1 / pxPerBin : Infinity;
}

/** Above this many bins per pixel, a level buys nothing visible and only costs bytes —
 *  time to step to the next-coarser level. The target band is 1–2 bins/px. */
export const MAX_BINS_PER_PX = 2;

/**
 * The finest (smallest-index) level whose bins/px does not exceed `MAX_BINS_PER_PX` —
 * i.e. the most detail the display can actually show without redundant reads. Scans from
 * level 0 (finest) upward, so a clip zoomed in past the finest level's own resolution
 * simply gets level 0 (there is nothing finer to give it — "blocky" is the ceiling, not a
 * bug). A clip zoomed out past the coarsest level's resolution gets the coarsest level
 * (index `levels.length - 1`) — the closest available, not a crash.
 *
 * **`pxPerMs` is DEVICE pixels per ms** — `view.pxPerMs * devicePixelRatio` — not CSS
 * pixels (D-056). The ceiling is a statement about the *display's* resolving power, and a
 * retina panel really can show twice the detail of a 1× one at the same zoom. Feeding it
 * CSS pixels was also what made the `barWidthPx` floor bite: at dpr 1 a level chosen
 * against CSS pixels can have bins half a device pixel wide, and a bar floored to 1
 * device pixel then overpaints its neighbour by 100 %. Interpreting the ceiling per
 * device pixel guarantees `binWidthCssPx * dpr >= 1 / MAX_BINS_PER_PX`, so bars stay at
 * least half a device pixel wide and the floor can never engage.
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
  /** Index of the first bin of `level` that the leftmost bar covers. */
  binStart: number;
  /** Number of BARS to draw — not, once `stride > 1`, the number of bins behind them. */
  binCount: number;
  /**
   * How many consecutive bins each bar summarises (max over the group). Normally 1: the
   * level chosen by `pickLevel` already puts bins at 0.5–1 device px. It only exceeds 1
   * when even the coarsest level in the ladder is finer than the display can use — a
   * belt-and-braces cap (D-056) that bounds `xs.length` at ~2 entries per device pixel
   * however long the clip and however short the ladder, rather than building a
   * 4000-element array per clip per frame to paint 200 px.
   */
  stride: number;
  /** Device-px left edge of each bar, canvas-local. `length === binCount`. */
  xs: number[];
  /** Device-px width of one bar. Bars are drawn contiguous (abutting), not
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
 * A bar narrower than this many device pixels cannot be seen at all, so the width is
 * floored here. Set to exactly the minimum `pickLevel`'s device-pixel ceiling already
 * guarantees (`1 / MAX_BINS_PER_PX`), which is why it is *defensive* rather than active:
 * on any input the level selection and the stride below can produce, the real width is
 * already at or above it, and the floor therefore never widens a bar past its own
 * spacing. (The old `Math.max(1, …)` floor did exactly that — finding 2.)
 */
const MIN_BAR_DEVICE_PX = 1 / MAX_BINS_PER_PX;

/**
 * Maps a clip's visible slice onto one level of its waveform pyramid, in both the CSS-px
 * (canvas placement) and device-px (draw loop) coordinate systems `dpr` scales between.
 *
 * Bins are anchored to **real time at the fixed analysis rate**, never stretched to fill
 * the clip's box: bin `i` of level `L` covers samples `[i·binSamples, (i+1)·binSamples)`,
 * i.e. clip-relative time `i · binDurationMs(L)`, and lands at
 * `span.startMs + i · binDurationMs(L)` on the timeline. `meta.totalSamples` therefore
 * plays no part in positioning — only in the "is there anything decoded at all" guard.
 * See `ANALYSIS_RATE_HZ`'s note and D-056 for why the alternative silently mis-draws
 * every correctly-synced clip.
 *
 * The `Math.min(lvl.bins, …)` clamps are what make that safe in both directions: an
 * analysis shorter than the container simply leaves the clip's tail unpainted, and one
 * longer than it is clipped at the box's right edge.
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

  // Level selection is a statement about the display's resolving power, so it is made in
  // DEVICE pixels (D-056). A non-finite or non-positive dpr (never seen in a browser, but
  // this is the only place that would divide by it) falls back to 1.
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const level = pickLevel(meta.levels, view.pxPerMs * scale);
  if (level < 0) return null;
  const lvl = meta.levels[level];
  if (lvl.bins <= 0) return null;

  const binMs = binDurationMs(lvl);
  if (!(binMs > 0)) return null;

  // Clip-relative time of the visible slice's two edges — `win` is already in CSS px
  // measured from the clip's own left edge.
  const startMsInClip = win.startPx / view.pxPerMs;
  const endMsInClip = win.endPx / view.pxPerMs;

  const binStart = Math.min(lvl.bins, Math.max(0, Math.floor(startMsInClip / binMs)));
  const binEnd = Math.min(lvl.bins, Math.max(binStart, Math.ceil(endMsInClip / binMs)));
  const visibleBins = binEnd - binStart;
  if (visibleBins <= 0) return null;

  // One bin's CSS-px width, then its device-px width — constant across the level (bins
  // are evenly spaced in time), so this is computed once rather than per bin.
  const binWidthCssPx = binMs * view.pxPerMs;
  const binWidthDevicePx = binWidthCssPx * scale;
  // Belt-and-braces (finding 11): if even the coarsest level in the ladder still crams
  // more than MAX_BINS_PER_PX bins onto a device pixel, group them into one bar rather
  // than emitting an `xs` entry the display cannot use.
  const stride =
    binWidthDevicePx > 0
      ? Math.max(1, Math.ceil(1 / (MAX_BINS_PER_PX * binWidthDevicePx)))
      : 1;
  const barWidthPx = Math.max(MIN_BAR_DEVICE_PX, binWidthDevicePx * stride);

  const binCount = Math.ceil(visibleBins / stride);
  const xs: number[] = new Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const binIndex = binStart + i * stride;
    xs[i] = (binIndex * binWidthCssPx - win.startPx) * scale;
  }

  return {
    level,
    binStart,
    binCount,
    stride,
    xs,
    barWidthPx,
    leftCssPx: win.startPx,
    widthCssPx: win.endPx - win.startPx,
  };
}

/**
 * The `[peak, rms]` amplitude (0–1) each of `geom`'s bars should be drawn at, read out of
 * one level's interleaved `u8` buffer.
 *
 * Pure, and separate from the canvas loop, for the same reason as everything else in this
 * module — but also because the bounds arithmetic here is exactly what went wrong once
 * already (finding 3): `bytes` can be SHORTER than `meta` promised, because `metaCache`
 * and `levelCache` are populated by two independent `invoke`s and the pyramid on disk can
 * be rebuilt between them (an mtime change, a sweep, a regenerate). Indexing past the end
 * yields `undefined`, `undefined / 255` is `NaN`, and `NaN <= 0` is *false* — so the old
 * `if (h <= 0) continue` guard let every one of them through to `fillRect(x, NaN, w,
 * NaN)`. Canvas happens to ignore non-finite arguments, so it degraded silently: luck,
 * not design.
 *
 * Bars with no backing bytes read as 0 (silence, nothing drawn) rather than as `NaN`.
 *
 * A `stride > 1` bar takes the **max** of its group in both channels. Max is exactly
 * right for peak; for RMS the energy-correct answer would be √(mean of the children's
 * mean-squares), which is not recoverable from quantized `u8` RMS values anyway. Erring
 * loud is the same call `peaks.rs`'s merge makes for peak, and `stride > 1` is only ever
 * reached below the ladder's coarsest level, where the bar is a single pixel.
 */
export function barAmplitudes(
  geom: BarGeometry,
  bytes: Uint8Array,
): { peak: Float32Array; rms: Float32Array } {
  const peak = new Float32Array(geom.binCount);
  const rms = new Float32Array(geom.binCount);
  const pairs = bytes.length >> 1;
  // How many bars the buffer actually backs — the stride-aware form of "clamp the loop
  // count to the buffer, not to what meta claimed".
  const availableBins = Math.max(0, pairs - geom.binStart);
  const bars = Math.min(geom.binCount, Math.ceil(availableBins / geom.stride));

  for (let i = 0; i < bars; i++) {
    const from = geom.binStart + i * geom.stride;
    const to = Math.min(from + geom.stride, pairs);
    let p = 0;
    let r = 0;
    for (let b = from; b < to; b++) {
      const bp = bytes[b * 2];
      const br = bytes[b * 2 + 1];
      if (bp > p) p = bp;
      if (br > r) r = br;
    }
    peak[i] = p / 255;
    rms[i] = r / 255;
  }
  return { peak, rms };
}
