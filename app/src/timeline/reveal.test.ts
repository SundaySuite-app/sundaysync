import { describe, expect, it } from "vitest";
import { MAX_PX_PER_MS, type TimelineView } from "./geometry";
import {
  REVEAL_EDGE_PX,
  REVEAL_MIN_PX,
  REVEAL_TARGET_PX,
  requestReveal,
  revealScrollTop,
  revealTarget,
  subscribeReveal,
} from "./reveal";

/** 1 px per ms, no pan, a 1000 px lane column — so a millisecond is a pixel and every
 *  expectation below can be read without arithmetic. */
const VIEW: TimelineView = { pxPerMs: 1, scrollMs: 0, widthPx: 1000 };

/** Long enough that nothing in this file accidentally hits the pan clamp. */
const SPAN_MS = 1_000_000;

function clip(startMs: number, lengthMs: number) {
  return { startMs, endMs: startMs + lengthMs };
}

/** What the clip's box measures, in the view a target describes. */
function drawn(target: { pxPerMs: number; scrollMs: number }, span: { startMs: number; endMs: number }) {
  const left = (span.startMs - target.scrollMs) * target.pxPerMs;
  const width = (span.endMs - span.startMs) * target.pxPerMs;
  return { left, right: left + width, width };
}

describe("revealTarget — where the view has to go", () => {
  it("leaves a comfortably visible clip exactly where it is", () => {
    // 100 px wide, 400 px from the left edge of a 1000 px column: on screen, legible,
    // nowhere near an edge. A reveal that moved this would jiggle the view for nothing.
    expect(revealTarget(clip(400, 100), VIEW, SPAN_MS)).toBeNull();
  });

  it("pans to centre a clip that is off the right edge", () => {
    const span = clip(50_000, 200);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    expect(target).not.toBeNull();
    // The zoom is untouched: 200 px is well past the threshold, so there is nothing to fix
    // about how wide the box is — only about where it is.
    expect(target.pxPerMs).toBe(VIEW.pxPerMs);
    const box = drawn(target, span);
    expect(box.left + box.width / 2).toBeCloseTo(VIEW.widthPx / 2, 6);
  });

  it("pans to a clip off the LEFT edge just the same", () => {
    const span = clip(1_000, 200);
    const scrolled: TimelineView = { ...VIEW, scrollMs: 5_000 };
    const target = revealTarget(span, scrolled, SPAN_MS)!;
    const box = drawn(target, span);
    expect(box.left + box.width / 2).toBeCloseTo(VIEW.widthPx / 2, 6);
  });

  it("moves for a clip that is technically on screen but jammed against an edge", () => {
    // Its right edge is 10 px from the frame — drawn, and reading as cut off. The rule is
    // «comfortably visible», and `REVEAL_EDGE_PX` is what that means in pixels.
    const span = clip(890, 100);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    expect(target).not.toBeNull();
    const box = drawn(target, span);
    expect(box.left).toBeGreaterThanOrEqual(REVEAL_EDGE_PX);
    expect(box.right).toBeLessThanOrEqual(VIEW.widthPx - REVEAL_EDGE_PX);
  });

  it("zooms a hairline up to something the eye can be sent to", () => {
    // The wedding case: at fit zoom a 3-second clip in a 15-hour day is a 2 px tick, and
    // «here it is» pointing at a tick is not an answer.
    const span = clip(5_000_000, 3_000);
    const fit: TimelineView = { pxPerMs: 0.0001, scrollMs: 0, widthPx: 1000 };
    const target = revealTarget(span, fit, 60_000_000)!;
    const box = drawn(target, span);
    expect(box.width).toBeCloseTo(REVEAL_TARGET_PX, 6);
    expect(box.width).toBeGreaterThanOrEqual(REVEAL_MIN_PX);
    // …and it lands centred, not merely wide.
    expect(box.left + box.width / 2).toBeCloseTo(fit.widthPx / 2, 6);
  });

  it("does not zoom a clip that is already wide enough, however far away it is", () => {
    const span = clip(900_000, REVEAL_MIN_PX + 1);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    expect(target.pxPerMs).toBe(VIEW.pxPerMs);
  });

  it("leaves the zoom alone for a clip with no length at all", () => {
    // `clip--nodur`: the outcome carries no duration for this file. Zooming to make a
    // zero-width box 48 px wide is a division by zero asking for infinite magnification —
    // the pan does the whole job instead, and the box stays a hairline, honestly.
    const span = clip(50_000, 0);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    expect(target.pxPerMs).toBe(VIEW.pxPerMs);
    expect(Number.isFinite(target.scrollMs)).toBe(true);
    const box = drawn(target, span);
    expect(box.left).toBeGreaterThanOrEqual(REVEAL_EDGE_PX);
  });

  it("never zooms past the bounds the rest of the timeline lives inside", () => {
    // A one-millisecond clip would ask for 48 px/ms. `clampZoom` is the ceiling, and the
    // reveal has to obey exactly the ceiling every other gesture does.
    const span = clip(500, 1);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    expect(target.pxPerMs).toBe(MAX_PX_PER_MS);
  });

  it("left-aligns a clip that is wider than the window rather than centring it", () => {
    // Centring a clip longer than the viewport puts its START off the left edge, and the
    // start is the thing the operator went looking for.
    const span = clip(50_000, 4_000);
    const target = revealTarget(span, VIEW, SPAN_MS)!;
    const box = drawn(target, span);
    expect(box.left).toBeCloseTo(REVEAL_EDGE_PX, 6);
  });

  it("is idempotent: revealing the same clip twice moves the view once", () => {
    const span = clip(50_000, 200);
    const first = revealTarget(span, VIEW, SPAN_MS)!;
    expect(revealTarget(span, { ...VIEW, ...first }, SPAN_MS)).toBeNull();
  });

  it("respects the pan clamp — a clip at the very start cannot scroll before zero", () => {
    const span = clip(0, 100);
    const scrolled: TimelineView = { ...VIEW, scrollMs: 5_000 };
    const target = revealTarget(span, scrolled, SPAN_MS)!;
    expect(target.scrollMs).toBe(0);
    // And asking again from there is a no-op rather than an endless nudge at the clamp.
    expect(revealTarget(span, { ...scrolled, ...target }, SPAN_MS)).toBeNull();
  });
});

describe("revealScrollTop — the tracks column, without scrollIntoView", () => {
  const RULER = 26;
  const BOX = 300;
  const MAX = 700;

  it("leaves a row that is already fully visible alone", () => {
    expect(revealScrollTop({ top: 100, height: 40 }, 50, BOX, RULER, MAX)).toBe(50);
  });

  it("scrolls up so a row above the window clears the sticky ruler", () => {
    // The whole of the inset: at `scrollTop = 100` the row's own top would sit exactly at
    // the top of the box, which is underneath the ruler that is stuck there.
    expect(revealScrollTop({ top: 100, height: 40 }, 400, BOX, RULER, MAX)).toBe(100 - RULER);
  });

  it("scrolls down just far enough to bring a row's bottom into view", () => {
    // 520 is the row's bottom minus the box's height: the row lands flush against the
    // bottom edge and nothing above it is scrolled away that did not have to be.
    expect(revealScrollTop({ top: 780, height: 40 }, 0, BOX, RULER, MAX)).toBe(520);
  });

  it("never scrolls before the top or past the end of the content", () => {
    expect(revealScrollTop({ top: 0, height: 40 }, 200, BOX, RULER, MAX)).toBe(0);
    expect(revealScrollTop({ top: 5_000, height: 40 }, 0, BOX, RULER, MAX)).toBe(MAX);
  });

  it("answers zero for a column with nothing to scroll", () => {
    expect(revealScrollTop({ top: 40, height: 40 }, 0, BOX, RULER, 0)).toBe(0);
  });
});

describe("the reveal request channel", () => {
  it("delivers the file to every subscriber, and stops at unsubscribe", () => {
    const seen: string[] = [];
    const off = subscribeReveal((file) => seen.push(file));
    requestReveal("/a/B.MP4");
    off();
    requestReveal("/a/C.MP4");
    expect(seen).toEqual(["/a/B.MP4"]);
  });

  it("is a no-op when nothing is listening — there is nowhere to go", () => {
    expect(() => requestReveal("/a/B.MP4")).not.toThrow();
  });

  it("fires again for the same file, because it is an event and not a value", () => {
    // The reason this is a channel rather than a piece of App state: picking the same row
    // twice has to take the view there twice, and a `selected`-shaped value would not change.
    const seen: string[] = [];
    const off = subscribeReveal((file) => seen.push(file));
    requestReveal("/a/B.MP4");
    requestReveal("/a/B.MP4");
    off();
    expect(seen).toEqual(["/a/B.MP4", "/a/B.MP4"]);
  });
});
