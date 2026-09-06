/**
 * «Kilder» finds the clip: the arithmetic of taking the view to a file, and the one-shot
 * channel that asks for it (F, D-096).
 *
 * Clicking a filename in the «Kilder» list has marked that clip since D-077 — the inspector
 * fills with the picture, the facts and the three decisions — and the timeline did not move.
 * On the owner's 386-clip wedding a clip is three pixels wide and is very often not on
 * screen at all, so the list answered "which file is this?" and left "where is it?"
 * unanswered, with a full inspector describing a box nobody could see.
 *
 * Two halves live here, and both of them are here rather than in the component for the same
 * reason `geometry.ts` and `viewport.ts` are:
 *
 *   - **the target** — {@link revealTarget} and {@link revealScrollTop} are pure functions
 *     of the clip's span, the current view and the box it has to fit in. This is the
 *     arithmetic that is easy to get quietly wrong (a centring that forgets the clip's own
 *     width, a scroll that lands the row under the sticky ruler) and impossible to see in a
 *     screenshot, so it is the arithmetic that gets unit-tested;
 *   - **the request** — {@link requestReveal} / {@link subscribeReveal}, a two-line external
 *     store in the shape `playhead.ts` already established. The popover and the timeline are
 *     siblings under App, and what passes between them is an EVENT ("take me to this file"),
 *     not a fact: state would need a nonce to fire twice for the same file, and App would be
 *     holding a value whose only meaning is that it changed.
 *
 * ## Only the popover, and that is the whole rule
 *
 * The reveal is on the «Kilder» path and on no other. A click on a clip must never move the
 * view: the operator is looking at the thing they clicked, and a timeline that panned under
 * that click would move the very box their eye is on. What makes «Kilder» different is that
 * the operator asked for the file BY NAME, from a list, with no idea where it is — reaching
 * it is the errand. So `SourcesPopover` calls {@link requestReveal} and nothing else does.
 */

import { clampZoom, type Spanned, type TimelineView } from "./geometry";
import { clampScroll } from "./viewport";

/**
 * Narrower than this and a clip is not something the eye can be sent to — at fit zoom on a
 * wedding every clip is a 2 px tick, and «here it is» pointing at a tick between 385 other
 * ticks is not an answer. Deliberately the same threshold `MIN_WAVEFORM_PX` uses for "is
 * there room to draw anything in here": below it a box stops carrying information.
 */
export const REVEAL_MIN_PX = 24;

/** …and what the zoom then aims for. Twice the threshold, so the clip is comfortably a BOX —
 *  wide enough for its own chrome (`CLIP_DRAWING_MIN_PX` is 6) with room to spare — rather
 *  than sitting exactly on the edge of legibility, where one notch of zoom out loses it. */
export const REVEAL_TARGET_PX = 48;

/** Breathing room the revealed clip keeps from the viewport's edges. The same number
 *  `FIT_PADDING_PX` leaves at the right edge when fitting: a box flush against the frame
 *  reads as cut off rather than as found. */
export const REVEAL_EDGE_PX = 24;

/** How long the view takes to travel. Long enough to be a MOVE — the operator has to see
 *  which way the timeline went, or the clip may as well have teleported and taken the whole
 *  timeline with it — and short enough not to be a wait. */
export const REVEAL_MS = 250;

/** Where the view has to go for a clip to be comfortably visible. */
export interface RevealTarget {
  pxPerMs: number;
  scrollMs: number;
}

/**
 * The view that brings `span` into comfortable view — or `null` when the view it already
 * has does that.
 *
 * `null` is not an optimisation, it is the behaviour: picking a file that is already on
 * screen and legible must not move the timeline at all. A reveal that always animated would
 * make «Kilder» a control that jiggles the view on every use.
 *
 * Two decisions, in this order, because the second depends on the first:
 *
 *   1. **Zoom**, only if the clip is drawn narrower than {@link REVEAL_MIN_PX}. A file with
 *      no length (an outcome that carries no duration for it, `clip--nodur`) has no width to
 *      zoom to — dividing by its zero would ask for infinite magnification — so the zoom is
 *      left alone and the pan does the whole job.
 *   2. **Pan**, evaluated at the zoom decided in (1). A clip that fits the window is
 *      CENTRED; one wider than the window is left-aligned with the same padding, because
 *      centring a two-hour clip puts its start off the left edge and the start is the thing
 *      the operator is looking for.
 */
export function revealTarget(
  span: Spanned,
  view: TimelineView,
  contentSpanMs: number,
): RevealTarget | null {
  const durationMs = Math.max(0, span.endMs - span.startMs);
  const drawnPx = durationMs * view.pxPerMs;
  const pxPerMs =
    durationMs > 0 && drawnPx < REVEAL_MIN_PX
      ? clampZoom(REVEAL_TARGET_PX / durationMs)
      : view.pxPerMs;
  const scrollMs = revealScrollMs(span, pxPerMs, view, contentSpanMs);
  if (pxPerMs === view.pxPerMs && scrollMs === view.scrollMs) return null;
  return { pxPerMs, scrollMs };
}

/** The pan half of {@link revealTarget}, at a zoom already decided. */
function revealScrollMs(
  span: Spanned,
  pxPerMs: number,
  view: TimelineView,
  contentSpanMs: number,
): number {
  const widthPx = view.widthPx;
  const clipPx = Math.max(0, span.endMs - span.startMs) * pxPerMs;
  const startX = (span.startMs - view.scrollMs) * pxPerMs;
  const endX = startX + clipPx;
  // Wider than the window (with its padding) — then "visible" can only be about the start.
  const fits = clipPx + 2 * REVEAL_EDGE_PX <= widthPx;
  const comfortable = fits
    ? startX >= REVEAL_EDGE_PX && endX <= widthPx - REVEAL_EDGE_PX
    : startX >= REVEAL_EDGE_PX && startX <= widthPx - REVEAL_EDGE_PX;
  if (comfortable) return view.scrollMs;
  const visibleMs = widthPx / pxPerMs;
  const wanted = fits
    ? span.startMs + (span.endMs - span.startMs) / 2 - visibleMs / 2
    : span.startMs - REVEAL_EDGE_PX / pxPerMs;
  return clampScroll(wanted, pxPerMs, widthPx, contentSpanMs);
}

/**
 * Where the tracks column has to be scrolled for a device's row to be visible — the
 * VERTICAL half, and it is a number rather than a gesture on purpose.
 *
 * **`scrollIntoView` is forbidden here**, and the suite has the scar: it scrolls *every*
 * scrollable ancestor, so "keep this row visible" inside a timeline moves the page, the
 * stage and anything else with an overflow between the row and the document. What this
 * returns is written straight to `.timeline__scroll`'s own `scrollTop`, which moves exactly
 * one box.
 *
 * `topInsetPx` is the sticky ruler: it sits at the top of the same scrolling box in every
 * frame, so the first `topInsetPx` of the visible area are not visible for a track at all,
 * and a row scrolled flush to `scrollTop` would land underneath it.
 *
 * Everything is in the scrolling box's own content coordinates (the ruler included), and the
 * answer is clamped to what the box can actually be scrolled to — a row already visible gets
 * the scroll it already has.
 */
export function revealScrollTop(
  band: { top: number; height: number },
  scrollTop: number,
  clientHeight: number,
  topInsetPx: number,
  maxScrollTop: number,
): number {
  const bottom = band.top + band.height;
  const max = Math.max(0, maxScrollTop);
  let next = scrollTop;
  if (band.top < scrollTop + topInsetPx) next = band.top - topInsetPx;
  else if (bottom > scrollTop + clientHeight) next = bottom - clientHeight;
  return Math.min(max, Math.max(0, next));
}

// ---- The request channel -------------------------------------------------------------

type RevealListener = (file: string) => void;

const listeners = new Set<RevealListener>();

/**
 * «Take me to this file.» Fired by the «Kilder» popover when a row is picked, and by nothing
 * else (see the note at the top of this file).
 *
 * Fire-and-forget: with no timeline mounted — the empty phase, or a scan in flight — this
 * does nothing at all, which is the honest behaviour. There is nowhere to go.
 */
export function requestReveal(file: string): void {
  for (const listener of listeners) listener(file);
}

/** Listen for reveal requests. Returns the unsubscribe, so an effect can be its own cleanup. */
export function subscribeReveal(listener: RevealListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
