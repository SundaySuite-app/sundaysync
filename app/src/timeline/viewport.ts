/**
 * Viewport bookkeeping for the interactive result timeline (v0.3, D-051) — the
 * pieces `geometry.ts` deliberately left out because they depend on *content*:
 * where the material starts and ends, what zoom shows all of it at once, how far
 * panning is allowed to go, and how big the scrollbar thumb should be.
 *
 * Pure and React-free for the same reason as its two neighbours: these are the
 * numbers that are easy to get subtly wrong (an off-by-a-padding fit, a thumb
 * that slides past the end of its trough) and hard to see in a screenshot.
 */

import { clampZoom, type Spanned, type TimelineView } from "./geometry";

/** Breathing room left at the right edge when fitting content to the window. */
export const FIT_PADDING_PX = 24;

/**
 * The timeline's own origin and total length, in ms.
 *
 * `originMs` is `min(0, earliest clip start)`: the reference is placed at zero by
 * construction (`crates/core/src/place.rs`), so in the normal case nothing starts
 * before it, `originMs` is 0, and timeline time equals the real `offset_seconds`
 * the ruler is showing. A camera that rolled *before* the reference gets a
 * negative offset, though — that clip would sit off the left edge forever, since
 * `geometry.ts` never scrolls below zero. So the whole timeline shifts by exactly
 * enough to bring it back into view, and the ruler then reads as
 * time-from-sequence-start.
 *
 * `spanMs` is at least 1 so nothing downstream divides by zero on an empty or
 * zero-length result.
 */
export function contentBounds(spans: Spanned[]): { originMs: number; spanMs: number } {
  let earliest = 0;
  let latest = 0;
  for (const s of spans) {
    if (s.startMs < earliest) earliest = s.startMs;
    if (s.endMs > latest) latest = s.endMs;
  }
  return { originMs: Math.min(0, earliest), spanMs: Math.max(1, latest - Math.min(0, earliest)) };
}

/**
 * The zoom that shows `spanMs` across `widthPx` with `paddingPx` to spare — the
 * initial "fit to content" view, and what the `0` key / Fit button return to.
 * Clamped to the zoom bounds, so an absurdly long or short result still lands on
 * a usable zoom instead of an unusable one.
 */
export function fitPxPerMs(
  spanMs: number,
  widthPx: number,
  paddingPx: number = FIT_PADDING_PX,
): number {
  const usable = Math.max(1, widthPx - paddingPx);
  return clampZoom(usable / Math.max(1, spanMs));
}

/**
 * Pan bound: keep the visible window inside `[0, contentSpanMs]`. When the
 * content is narrower than the window (zoomed out past fit) the only legal
 * scroll is 0 — otherwise the user could pan the material off-screen entirely
 * and be left staring at an empty grid with no way back but the Fit button.
 */
export function clampScroll(
  scrollMs: number,
  pxPerMs: number,
  widthPx: number,
  contentSpanMs: number,
): number {
  const visibleMs = widthPx / pxPerMs;
  const max = Math.max(0, contentSpanMs - visibleMs);
  return Math.min(Math.max(0, scrollMs), max);
}

/** Thumb geometry as fractions of the trough, ready for `left`/`width` in %. */
export interface ScrollbarMetrics {
  /** Thumb width, 0–1 of the trough. 1 means "everything is visible". */
  thumbFrac: number;
  /** Thumb left edge, 0–1. Never lets the thumb overhang the trough. */
  offsetFrac: number;
}

/** Smallest thumb we will draw, as a fraction of the trough — below this it stops being
 *  a grabbable target. At a 3-hour result and maximum zoom the honest figure is ~0.00005. */
const MIN_THUMB_FRAC = 0.02;

/**
 * Thumb width and position.
 *
 * `offsetFrac` is the scroll position expressed as a fraction of the thumb's own
 * TRAVEL (`1 - thumbFrac`), not of the content. Those are the same thing only while the
 * thumb is its natural width; once `MIN_THUMB_FRAC` inflates it — which is exactly the
 * deep-zoom case — a raw `scrollMs / span` runs past the end of the travel and the old
 * `Math.min(1 - thumbFrac, …)` clamp then pinned it there. Measured: a 3-hour result at
 * maximum zoom sat at `offsetFrac === 0.98` for everything from 99 % of maximum scroll to
 * the very end, so the thumb was visibly frozen across the last ~4 minutes of material
 * while the timeline underneath kept moving (finding 10).
 *
 * Scaling by the travel instead makes both ends exact by construction — 0 at the start,
 * `1 - thumbFrac` at the end (thumb flush right), monotonic in between — and needs no
 * clamp to stay inside the trough.
 *
 * The inverse — thumb left edge → scroll — is [`thumbOffsetFracToScrollMs`], which is what
 * a drag that tracks where the thumb was *grabbed* uses. `scrollbarFracToScrollMs` below
 * is the other mapping, for a bare click on empty trough.
 */
export function scrollbarMetrics(
  view: TimelineView,
  contentSpanMs: number,
): ScrollbarMetrics {
  const span = Math.max(1, contentSpanMs);
  const visibleMs = view.widthPx / view.pxPerMs;
  const thumbFrac = Math.min(1, Math.max(MIN_THUMB_FRAC, visibleMs / span));
  const maxScrollMs = Math.max(0, span - visibleMs);
  const scrolledFrac = maxScrollMs > 0 ? Math.min(1, Math.max(0, view.scrollMs / maxScrollMs)) : 0;
  return { thumbFrac, offsetFrac: scrolledFrac * (1 - thumbFrac) };
}

/**
 * Where to scroll when the user grabs the scrollbar at `frac` (0–1 across the
 * trough): centre the visible window on that point, then clamp. Centring rather
 * than left-aligning is what makes click-to-jump land where the eye expects.
 *
 * This is the **empty-trough** mapping only. Dragging the thumb itself uses
 * [`thumbOffsetFracToScrollMs`] — treating a grabbed thumb's position as the *centre* of
 * the wanted window is what made grabbing its left edge jump half a window backwards
 * (finding 5).
 */
export function scrollbarFracToScrollMs(
  frac: number,
  view: TimelineView,
  contentSpanMs: number,
): number {
  const visibleMs = view.widthPx / view.pxPerMs;
  const target = frac * Math.max(1, contentSpanMs) - visibleMs / 2;
  return clampScroll(target, view.pxPerMs, view.widthPx, contentSpanMs);
}

/**
 * The exact inverse of [`scrollbarMetrics`]: given where the thumb's LEFT EDGE should sit
 * (0–1 of the trough), the scroll it represents.
 *
 * `scrollbarMetrics` maps `scrollMs → offsetFrac = scrolledFrac · (1 - thumbFrac)`, so the
 * way back is `scrollMs = offsetFrac / (1 - thumbFrac) · maxScrollMs`. Going through the
 * thumb's TRAVEL rather than through the content fraction is what makes the round trip
 * exact at deep zoom, where `MIN_THUMB_FRAC` has inflated the thumb past its natural width
 * and the two stop being the same number.
 *
 * A drag calls this with `pointerFrac - grabOffset`, where `grabOffset` is where inside
 * the thumb the pointer went down. That is the whole of finding 5: the position under the
 * user's finger is where they *put* it, not the middle of the window.
 *
 * When everything is visible (`thumbFrac === 1`) there is no travel and no scroll — 0.
 */
export function thumbOffsetFracToScrollMs(
  offsetFrac: number,
  view: TimelineView,
  contentSpanMs: number,
): number {
  const { thumbFrac } = scrollbarMetrics(view, contentSpanMs);
  const travel = 1 - thumbFrac;
  if (travel <= 0) return 0;
  const visibleMs = view.widthPx / view.pxPerMs;
  const maxScrollMs = Math.max(0, Math.max(1, contentSpanMs) - visibleMs);
  return clampScroll(
    (offsetFrac / travel) * maxScrollMs,
    view.pxPerMs,
    view.widthPx,
    contentSpanMs,
  );
}

/**
 * The scrollbar's `aria-valuenow`, 0–100.
 *
 * Position within the thumb's TRAVEL, not within the content — so 100 is actually
 * reachable. Reporting `offsetFrac · 100` (which is a fraction of the whole trough) meant
 * the value maxed out at `(1 - thumbFrac) · 100`: 75 on a quarter-width thumb, 98 at deep
 * zoom, and a screen reader announcing "75 %" for a scrollbar that is flush against its
 * right end is simply wrong (finding 14).
 */
export function scrollbarValueNow(view: TimelineView, contentSpanMs: number): number {
  const { thumbFrac, offsetFrac } = scrollbarMetrics(view, contentSpanMs);
  const travel = 1 - thumbFrac;
  return travel > 0 ? Math.round((offsetFrac / travel) * 100) : 0;
}
