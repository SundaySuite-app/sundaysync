// Adapted from SundayEdit (same owner) — src/features/timeline/geometry.ts; see docs/DECISIONS.md D-051.

/**
 * Pure timeline math — the spatial core of the interactive result timeline
 * (v0.3, D-051). Kept free of React/DOM so the tricky parts (time↔pixel
 * mapping, zoom-around-anchor, ruler tick selection, and the virtualization
 * window that keeps a placement list with hundreds of clips smooth) are
 * unit-tested in isolation.
 */

/** The visible viewport: zoom (pxPerMs), pan (scrollMs = time at x=0), width. */
export interface TimelineView {
  pxPerMs: number;
  scrollMs: number;
  widthPx: number;
}

/**
 * Zoom bounds. 1e-5 px/ms is the way-out floor — 1 px per 100 s, so a 736 px lane (the
 * width the timeline actually has at 1280×800: the window less the 300 px inspector, the
 * 224 px gutter and the frame's own chrome) shows ~20 hours, and «Tilpass» — which fits
 * with `FIT_PADDING_PX` to spare — reaches ~19.8 h. 2 px/ms is sub-frame-level at the
 * other end (0.5 ms per pixel).
 *
 * **The floor was 2e-5 until V06-R3 (D-084), and that number could not fit the owner's own
 * wedding.** 2e-5 across 736 px is 10.2 h; the shoot is 15.5 h, so «Tilpass» clamped, the
 * view stopped at ten hours of it, and 40 of the 386 clips sat past the right edge with no
 * gesture that brought them back — the Fit button is the gesture that is supposed to. It
 * was v0.5's highest-value open item, and halving the floor is the whole fix: 19.8 h covers
 * a wedding that starts with the hairdresser and ends with the last dance, with a night's
 * margin left over.
 *
 * What halving it costs is one step of waveform detail at the very floor, and the ladder
 * already has the answer: `MIN_WAVEFORM_PX` (D-072) means a clip narrower than 24 px draws
 * no waveform at all, which at this zoom is every clip shorter than 40 minutes — and for
 * the handful that are longer, `barGeometry`'s stride cap groups 2–3 bins per bar rather
 * than emitting an `xs` entry per bin. Both are measured in `waveformDraw.test.ts`.
 */
export const MIN_PX_PER_MS = 0.00001;
export const MAX_PX_PER_MS = 2;

export function clampZoom(pxPerMs: number): number {
  return Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, pxPerMs));
}

export function msToX(ms: number, view: TimelineView): number {
  return (ms - view.scrollMs) * view.pxPerMs;
}

export function xToMs(x: number, view: TimelineView): number {
  return view.scrollMs + x / view.pxPerMs;
}

/** [startMs, endMs] currently visible in the viewport. */
export function visibleRange(view: TimelineView): [number, number] {
  return [view.scrollMs, view.scrollMs + view.widthPx / view.pxPerMs];
}

/**
 * Zoom by `factor` (>1 in, <1 out) while keeping the time under `anchorX`
 * pinned to that pixel — the standard "zoom toward the cursor" behaviour.
 * Clamps zoom and prevents scrolling before 0.
 */
export function zoomAround(
  view: TimelineView,
  factor: number,
  anchorX: number,
): TimelineView {
  const anchorMs = xToMs(anchorX, view);
  const pxPerMs = clampZoom(view.pxPerMs * factor);
  // Keep anchorMs at anchorX: anchorX = (anchorMs - scrollMs) * pxPerMs
  const scrollMs = Math.max(0, anchorMs - anchorX / pxPerMs);
  return { ...view, pxPerMs, scrollMs };
}

/** A time span, in milliseconds — the shape `visibleClips` virtualizes over. */
export interface Spanned {
  startMs: number;
  endMs: number;
}

/** First index whose `endMs` >= `ms`, via binary search on start-sorted
 *  spans. Used to bound the virtualization scan. */
function lowerBound<T extends Spanned>(items: T[], ms: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].endMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Indices of clips overlapping [startMs, endMs] (start-sorted input), with
 * `buffer` extra items each side so pan/zoom doesn't pop clips in and out.
 * This is the virtualization window — only these need DOM nodes.
 */
export function visibleClips<T extends Spanned>(
  clips: T[],
  startMs: number,
  endMs: number,
  buffer = 5,
): { index: number; item: T }[] {
  const out: { index: number; item: T }[] = [];
  let i = Math.max(0, lowerBound(clips, startMs) - buffer);
  for (; i < clips.length; i++) {
    const c = clips[i];
    if (c.startMs > endMs) {
      // Past the window — emit `buffer` trailing items then stop.
      for (let j = 0; j < buffer && i + j < clips.length; j++) {
        out.push({ index: i + j, item: clips[i + j] });
      }
      break;
    }
    out.push({ index: i, item: c });
  }
  return out;
}

const NICE_INTERVALS_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];

/** Pick the smallest "nice" tick interval whose on-screen spacing is at least
 *  `minPxBetween`, so ruler labels never crowd. */
export function tickIntervalMs(view: TimelineView, minPxBetween = 80): number {
  for (const interval of NICE_INTERVALS_MS) {
    if (interval * view.pxPerMs >= minPxBetween) return interval;
  }
  return NICE_INTERVALS_MS[NICE_INTERVALS_MS.length - 1];
}

/** Ruler tick times across the visible range at the chosen nice interval. */
export function rulerTicks(view: TimelineView, minPxBetween = 80): number[] {
  const interval = tickIntervalMs(view, minPxBetween);
  const [start, end] = visibleRange(view);
  const first = Math.ceil(start / interval) * interval;
  const ticks: number[] = [];
  for (let ms = first; ms <= end; ms += interval) ticks.push(ms);
  return ticks;
}

/**
 * A ruler tick's label: the timecode, minus the part the chosen tick spacing cannot
 * resolve (V06-R3).
 *
 * `formatTimecode` always prints milliseconds, and it is right to: it is the transport's
 * clock, and the offsets this app measures are sub-frame (see the note below). A RULER is a
 * different reader. At the zoom a whole shoot is looked at, `tickIntervalMs` picks one tick
 * per hour — and every label then ended in the same `.000`, four characters of nothing
 * repeated across the whole ruler, on the one row where the width of a label decides
 * whether the rightmost one can be drawn at all.
 *
 * The rule is the interval, not the zoom: milliseconds are dropped exactly when a tick is a
 * whole second or more apart, because that is when no two ticks could differ in them.
 */
export function tickLabel(ms: number, intervalMs: number): string {
  const full = formatTimecode(ms);
  return intervalMs >= 1000 ? full.slice(0, -4) : full;
}

/**
 * HH:MM:SS.mmm timecode — milliseconds, not frames. GCC-PHAT offsets resolve
 * to fractions of a millisecond (PLAN.md §4.3) and are sub-frame; a
 * frame-based HH:MM:SS:FF readout would silently round away precision the
 * engine actually measured, and would need an fps this read-mostly viewer
 * has no reliable single value for (mixed-fps shoots are a documented
 * warning, §9). Hours are omitted when zero.
 */
export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalWholeSec = Math.floor(clamped / 1000);
  const h = Math.floor(totalWholeSec / 3600);
  const m = Math.floor((totalWholeSec % 3600) / 60);
  const s = totalWholeSec % 60;
  const millis = Math.floor(clamped % 1000);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  const tail = `${pad2(m)}:${pad2(s)}.${pad3(millis)}`;
  return h > 0 ? `${h}:${tail}` : tail;
}
