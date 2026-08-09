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

export function scrollbarMetrics(
  view: TimelineView,
  contentSpanMs: number,
): ScrollbarMetrics {
  const span = Math.max(1, contentSpanMs);
  const visibleMs = view.widthPx / view.pxPerMs;
  const thumbFrac = Math.min(1, Math.max(0.02, visibleMs / span));
  const offsetFrac = Math.min(1 - thumbFrac, Math.max(0, view.scrollMs / span));
  return { thumbFrac, offsetFrac };
}

/**
 * Where to scroll when the user grabs the scrollbar at `frac` (0–1 across the
 * trough): centre the visible window on that point, then clamp. Centring rather
 * than left-aligning is what makes click-to-jump land where the eye expects.
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
