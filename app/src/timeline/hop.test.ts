import { describe, expect, it } from "vitest";
import type { TimelineView } from "./geometry";
import {
  CLIP_DRAWING_MIN_PX,
  HAIRLINE_WIDTH_PX,
  HOP_JITTER_X_PX,
  HOP_JITTER_Y_PX,
  HOP_MAX_DELAY_MS,
  HOP_MIN_JITTER_X_PX,
  HOP_TOTAL_MS,
  HOP_TRAVEL_MS,
  LANE_MAX_PX,
  LANE_MIN_PX,
  clipBoxes,
  clipDrawing,
  clipHeightFor,
  hopChoreography,
  hopDeltas,
  hopExits,
  laneHeightFor,
  roomBeforeNext,
  type HopTrack,
} from "./hop";

/** The pitch every assertion below that does not say otherwise is written against — the
 *  floor, which is what a room too full to grow into gives back. `LANE_HEIGHT_PX` was a
 *  constant these tests imported; since D-091 the pitch is a per-render value, so the tests
 *  state which one they mean (D-085: re-express, never delete). */
const LANE = LANE_MIN_PX;

/** 1 px per ms, no pan — so a millisecond of movement is a pixel of movement and the
 *  expectations below can be read without arithmetic. */
const VIEW: TimelineView = { pxPerMs: 1, scrollMs: 0, widthPx: 1000 };

function track(...rows: { file: string; startMs: number; endMs: number }[][]): HopTrack {
  return { rows };
}

function clip(file: string, startMs: number, lengthMs = 100) {
  return { file, startMs, endMs: startMs + lengthMs };
}

describe("clipBoxes", () => {
  it("puts the first clip of the first track just inside the track and lane hairlines", () => {
    const boxes = clipBoxes([track([clip("a", 0)])], VIEW, LANE);
    // 1 px track border + 1 px lane border + the clip's own 3 px inset.
    expect(boxes.get("a")).toEqual({ x: 0, y: 5, width: 100, hairline: false });
  });

  it("stacks the second track below the first by the first track's full height", () => {
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])],
      VIEW,
      LANE,
    );
    expect(boxes.get("a")!.y).toBe(5);
    expect(boxes.get("b")!.y).toBe(5 + LANE);
    // Two lanes above, so the second track starts two lane heights down.
    expect(boxes.get("c")!.y).toBe(5 + 2 * LANE);
  });

  it("gives an empty track one lane's worth of height anyway (§7.5)", () => {
    const boxes = clipBoxes([track(), track([clip("a", 0)])], VIEW, LANE);
    expect(boxes.get("a")!.y).toBe(5 + LANE);
  });

  it("maps x through the view, pan and zoom included", () => {
    const zoomed: TimelineView = { pxPerMs: 0.5, scrollMs: 200, widthPx: 1000 };
    const boxes = clipBoxes([track([clip("a", 1000, 400)])], zoomed, LANE);
    expect(boxes.get("a")).toEqual({ x: (1000 - 200) * 0.5, y: 5, width: 200, hairline: false });
  });

  it("floors a zero-length clip at the width the component draws it at", () => {
    // Re-expressed for D-091 (the floor is a hairline now, not a 3 px sliver), not relaxed:
    // the claim is still "a clip with no length is drawn at exactly the width `Clip.tsx`
    // gives it", which is the whole reason both go through `clipDrawing`.
    const boxes = clipBoxes([track([clip("a", 500, 0)])], VIEW, LANE);
    expect(boxes.get("a")!.width).toBe(HAIRLINE_WIDTH_PX);
    expect(boxes.get("a")!.hairline).toBe(true);
  });

  it("is empty for no tracks, and for tracks with no clips", () => {
    expect(clipBoxes([], VIEW, LANE).size).toBe(0);
    expect(clipBoxes([track(), track()], VIEW, LANE).size).toBe(0);
  });

  // ── V06-R2b (D-083): the row pitch is ONE number, and this is where it is checked ────
  //
  // The pitch went 34 → 40 so the gutter could carry two lines, and since D-091 it is not a
  // constant at all but `laneHeightFor`'s per-render answer. Everything vertical
  // in the timeline is that constant times an integer: `Track.tsx` sizes the track and each
  // lane from it, `clipBoxes` sums it, `useHop` places ghosts by it. The risk the stage
  // carried is a lane the browser grew — a `min-height` on the two-line gutter taller than
  // the constant — because then the DOM's pitch and this module's pitch disagree by a few
  // px per track and every clip below the first one hops to a row it is not in. Nothing
  // here can see the DOM, so what these two assert is the other half: that the arithmetic
  // is the constant and nothing but the constant, at any value it is ever given.

  it("puts consecutive rows of one track exactly one lane height apart", () => {
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)], [clip("c", 0)])],
      VIEW,
      LANE,
    );
    const [a, b, c] = [boxes.get("a")!.y, boxes.get("b")!.y, boxes.get("c")!.y];
    expect(b - a).toBe(LANE);
    expect(c - b).toBe(LANE);
  });

  it("starts a two-lane track's second row at exactly trackTop + one lane height", () => {
    // `trackTop` is not a number this module exports, so it is taken the only way a caller
    // could: the first row of a track IS its top plus the two hairlines and the inset, and
    // a following track's top is the previous one's top plus its lanes. One track of two
    // lanes, then a second track — so both readings of "trackTop" are exercised at once.
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])],
      VIEW,
      LANE,
    );
    const trackTop = boxes.get("a")!.y;
    expect(boxes.get("b")!.y).toBe(trackTop + LANE);
    // …and the next track begins after exactly two of them, never after "two plus whatever
    // the gutter needed".
    expect(boxes.get("c")!.y).toBe(trackTop + 2 * LANE);
  });

  it("leaves room inside a lane for the clip it describes, at every pitch", () => {
    // The ghosts are drawn `clipHeightFor(lane)` tall at these positions; if the derivation
    // and the lane height ever drift, a ghost stops matching the clip beside it. Asserted
    // across the whole range the pitch can now take rather than at the one value it used to
    // have — the derivation is the invariant, 33 was only ever an instance of it.
    for (const lane of [LANE_MIN_PX, 47, 68, LANE_MAX_PX]) {
      expect(clipHeightFor(lane)).toBeLessThan(lane);
      expect(clipHeightFor(lane)).toBe(lane - 1 - 2 * 3);
    }
  });
});

describe("hopDeltas", () => {
  it("carries a clip that moved along its own track", () => {
    const before = [track([clip("a", 1000)])];
    const after = [track([clip("a", 1400)])];
    // The clip is drawn 400 px further right, so it starts 400 px to the LEFT of there.
    expect(hopDeltas(before, VIEW, LANE, after, VIEW, LANE).get("a")).toEqual({ dx: -400, dy: 0 });
  });

  it("reports a zero delta for a clip that did not move", () => {
    const same = [track([clip("a", 1000)])];
    expect(hopDeltas(same, VIEW, LANE, same, VIEW, LANE).get("a")).toEqual({ dx: 0, dy: 0 });
  });

  it("carries a clip that changed track", () => {
    const before = [track([clip("a", 0)]), track([clip("b", 0)])];
    const after = [track([clip("b", 0)]), track([clip("a", 0)])];
    const deltas = hopDeltas(before, VIEW, LANE, after, VIEW, LANE);
    // `a` was on the first row and is now on the second: it starts one lane HIGHER than
    // where it now lives, and `b` starts one lane lower.
    expect(deltas.get("a")).toEqual({ dx: 0, dy: -LANE });
    expect(deltas.get("b")).toEqual({ dx: 0, dy: LANE });
  });

  it("shifts everything below a track that gained a lane", () => {
    const before = [track([clip("a", 0)]), track([clip("c", 0)])];
    // The first track now stacks two rows — its own second clip, and every track under it,
    // move down by a lane.
    const after = [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])];
    const deltas = hopDeltas(before, VIEW, LANE, after, VIEW, LANE);
    expect(deltas.get("a")).toEqual({ dx: 0, dy: 0 });
    expect(deltas.get("c")).toEqual({ dx: 0, dy: -LANE });
    // `b` is new — nothing to hop from.
    expect(deltas.has("b")).toBe(false);
  });

  it("shifts everything below a track that lost a lane", () => {
    const before = [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])];
    const after = [track([clip("a", 0)]), track([clip("c", 0)])];
    expect(hopDeltas(before, VIEW, LANE, after, VIEW, LANE).get("c")).toEqual({
      dx: 0,
      dy: LANE,
    });
  });

  it("ignores files that exist on only one side", () => {
    const before = [track([clip("gone", 0)])];
    const after = [track([clip("new", 0)])];
    expect(hopDeltas(before, VIEW, LANE, after, VIEW, LANE).size).toBe(0);
  });

  it("is empty when either side has nothing to draw", () => {
    const some = [track([clip("a", 0)])];
    expect(hopDeltas([], VIEW, LANE, some, VIEW, LANE).size).toBe(0);
    expect(hopDeltas(some, VIEW, LANE, [], VIEW, LANE).size).toBe(0);
    expect(hopDeltas([], VIEW, LANE, [], VIEW, LANE).size).toBe(0);
  });

  it("measures each side under its own view when the two differ", () => {
    const before = [track([clip("a", 1000)])];
    const after = [track([clip("a", 1000)])];
    const zoomedOut: TimelineView = { pxPerMs: 0.5, scrollMs: 0, widthPx: 1000 };
    // Same timeline position, half the zoom: the box is drawn at 500 instead of 1000, so
    // it would have to start 500 px to the right of its new home.
    expect(hopDeltas(before, VIEW, LANE, after, zoomedOut, LANE).get("a")).toEqual({ dx: 500, dy: 0 });
  });
});

// ── V06-G2 (D-091) ──────────────────────────────────────────────────────────────────────

describe("laneHeightFor — the lanes grow into the room", () => {
  it("gives every row an equal share of the stage", () => {
    // 600 px of stage, four rows: 150 each — except the ceiling says 90.
    expect(laneHeightFor(4, 600)).toBe(LANE_MAX_PX);
    // 600 px, eight rows: 75 each, which is inside the band and therefore the answer.
    expect(laneHeightFor(8, 600)).toBe(75);
  });

  it("clamps at both ends, and the boundaries are exact on both sides", () => {
    // The floor. `available / rows` exactly 40 is still 40; a hair under it clamps up.
    expect(laneHeightFor(10, 10 * LANE_MIN_PX)).toBe(LANE_MIN_PX);
    expect(laneHeightFor(10, 10 * LANE_MIN_PX - 1)).toBe(LANE_MIN_PX);
    expect(laneHeightFor(10, 10 * LANE_MIN_PX + 10)).toBe(LANE_MIN_PX + 1);
    // The wedding: twenty rows in a laptop's stage cannot grow at all.
    expect(laneHeightFor(20, 420)).toBe(LANE_MIN_PX);

    // The ceiling. Exactly 90 each is 90; one pixel more per row is still 90.
    expect(laneHeightFor(3, 3 * LANE_MAX_PX)).toBe(LANE_MAX_PX);
    expect(laneHeightFor(3, 3 * LANE_MAX_PX + 3)).toBe(LANE_MAX_PX);
    expect(laneHeightFor(3, 3 * LANE_MAX_PX - 3)).toBe(LANE_MAX_PX - 1);
  });

  it("floors rather than rounds, so the rows can never be taller than the room", () => {
    // The whole reason there is no feedback loop between the pitch and the ResizeObserver
    // that measures the stage: `rows * lane <= available`, always, so growing the lanes can
    // never summon the scrollbar that would change the measurement.
    for (const rows of [1, 2, 3, 5, 7, 11, 13]) {
      for (const available of [137, 301, 449, 512, 803]) {
        const lane = laneHeightFor(rows, available);
        if (lane > LANE_MIN_PX) expect(rows * lane).toBeLessThanOrEqual(available);
      }
    }
  });

  it("answers the floor for a room it has not been told about", () => {
    // The first commit, before the observer has run once: an unmeasured room draws exactly
    // what v0.6.0-beta.3 drew, and grows a frame later rather than flickering through a
    // nonsense pitch.
    for (const nothing of [0, -1, NaN, Infinity, -Infinity]) {
      expect(laneHeightFor(3, nothing)).toBe(LANE_MIN_PX);
    }
    for (const nothing of [0, -1, NaN]) expect(laneHeightFor(nothing, 800)).toBe(LANE_MIN_PX);
  });

  it("is the number BOTH consumers use — the D-083 invariant, restated for a value", () => {
    // The failure this guards is silent by construction: `Track` writes the pitch into every
    // lane's `height` and `clipBoxes` sums it, and if the two ever disagreed the clips below
    // the first device would hop to rows they are not in — with no error anywhere. Nothing
    // here can see the DOM, so what is asserted is the other half: `clipBoxes` uses the
    // pitch it is GIVEN, at any value, rather than a constant of its own.
    const tracks = [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])];
    for (const lane of [LANE_MIN_PX, 53, 68, LANE_MAX_PX]) {
      const boxes = clipBoxes(tracks, VIEW, lane);
      expect(boxes.get("b")!.y - boxes.get("a")!.y).toBe(lane);
      expect(boxes.get("c")!.y - boxes.get("a")!.y).toBe(2 * lane);
    }
  });

  it("lands a hop pixel-true at a grown lane height", () => {
    // The D-083 hazard in its actual shape: deltas computed at one pitch, clips drawn at
    // another. A clip that changed row hops by exactly one lane — 68 px when the lanes are
    // 68 px, not 40 — and a clip that did not move has a delta of zero at every pitch.
    const before = [track([clip("a", 0)]), track([clip("b", 0)])];
    const after = [track([clip("b", 0)]), track([clip("a", 0)])];
    const lane = laneHeightFor(2, 2 * 68);
    expect(lane).toBe(68);
    const deltas = hopDeltas(before, VIEW, lane, after, VIEW, lane);
    expect(deltas.get("a")).toEqual({ dx: 0, dy: -lane });
    expect(deltas.get("b")).toEqual({ dx: 0, dy: lane });

    // …and where `Track` draws them at that pitch: `clipBoxes` at 68 puts `a`'s new row one
    // 68 px lane below the first, which is the position the delta above is measured to.
    const boxes = clipBoxes(after, VIEW, lane);
    expect(boxes.get("a")!.y - boxes.get("b")!.y).toBe(lane);
  });

  it("keeps the hop honest when the two layouts have DIFFERENT pitches", () => {
    // A sync that drops a device changes the row count, so `laneHeightFor` can legitimately
    // answer differently for the two sides — and the FLIP has to measure each side at its
    // own. Three rows at 90, then two at 90 (both clamped): `a` stays on row 0 and does not
    // move; with a single pitch for both sides this would still be right, so the case that
    // proves it is the one where the pitches differ.
    const before = [track([clip("a", 0)]), track([clip("b", 0)]), track([clip("c", 0)])];
    const after = [track([clip("a", 0)]), track([clip("c", 0)])];
    const oldLane = laneHeightFor(3, 300); // 100 → clamped to 90
    const newLane = laneHeightFor(2, 300); // 150 → clamped to 90
    expect([oldLane, newLane]).toEqual([LANE_MAX_PX, LANE_MAX_PX]);

    // Now force them apart, which is what a taller stage does: 3 rows in 210 px is 70,
    // 2 rows in 210 px is 90.
    const tight = laneHeightFor(3, 210);
    const roomy = laneHeightFor(2, 210);
    expect([tight, roomy]).toEqual([70, LANE_MAX_PX]);
    // `c` was the third row at 70 and is the second at 90: it starts 2·70 − 1·90 = 50 px
    // BELOW where it now lives, so its delta is +50.
    const deltas = hopDeltas(before, VIEW, tight, after, VIEW, roomy);
    expect(deltas.get("c")).toEqual({ dx: 0, dy: 2 * tight - roomy });
    expect(deltas.get("a")).toEqual({ dx: 0, dy: 0 });
  });
});

describe("clipDrawing — a clip never crosses its neighbour's start", () => {
  it("draws a clip at its own width when nothing is in the way", () => {
    expect(clipDrawing(400, Number.POSITIVE_INFINITY)).toEqual({ width: 400, hairline: false });
    expect(clipDrawing(400, 400)).toEqual({ width: 400, hairline: false });
  });

  it("yields the WIDTH, never the start, when the room is short", () => {
    // The declared start is the app's claim about when the camera rolled and is sacred; the
    // width is a drawing and can be cut. 3 px of room means a box no wider than 3 px,
    // wherever the clip's own duration would have taken it — and since 3 px is under the
    // drawing threshold, what is drawn there is a tick.
    expect(clipDrawing(400, 3)).toEqual({ width: HAIRLINE_WIDTH_PX, hairline: true });
    expect(clipDrawing(400, 1)).toEqual({ width: 1, hairline: true });
    expect(clipDrawing(12, 7)).toEqual({ width: 7, hairline: false });
  });

  it("draws a sub-threshold clip at the TICK's width, not at its own", () => {
    // A five-pixel box tells the operator nothing about how long its clip is, and a row of
    // ragged five-pixel stubs is harder to count than a row of even ticks. Under the
    // threshold the box stops being a picture of a duration and becomes a mark.
    expect(clipDrawing(5.9, Number.POSITIVE_INFINITY)).toEqual({
      width: HAIRLINE_WIDTH_PX,
      hairline: true,
    });
    expect(clipDrawing(3, Number.POSITIVE_INFINITY).width).toBe(HAIRLINE_WIDTH_PX);
    // …and above it, the box is its own width to the pixel.
    expect(clipDrawing(6.1, Number.POSITIVE_INFINITY).width).toBe(6.1);
  });

  it("floors a zero-length clip at a hairline — but not past the room", () => {
    expect(clipDrawing(0, Number.POSITIVE_INFINITY)).toEqual({
      width: HAIRLINE_WIDTH_PX,
      hairline: true,
    });
    // …and the floor itself yields. This is the exact case the old 3 px minimum got wrong:
    // two clips whose starts are one pixel apart used to be drawn 3 px wide each and
    // overlapped by two.
    expect(clipDrawing(0, 1)).toEqual({ width: 1, hairline: true });
    expect(clipDrawing(0, 0)).toEqual({ width: 0, hairline: true });
  });

  it("puts the hairline boundary exactly at CLIP_DRAWING_MIN_PX, both sides", () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(clipDrawing(CLIP_DRAWING_MIN_PX, inf)).toEqual({
      width: CLIP_DRAWING_MIN_PX,
      hairline: false,
    });
    expect(clipDrawing(CLIP_DRAWING_MIN_PX - 0.001, inf).hairline).toBe(true);
    expect(clipDrawing(CLIP_DRAWING_MIN_PX + 0.001, inf).hairline).toBe(false);
    // And when it is the ROOM that decides the width, the boundary is read off the drawn
    // width rather than the wanted one — a 400 px clip with 6 px of room is a 6 px drawing,
    // and a 400 px clip with 5.9 px of room is a tick.
    expect(clipDrawing(400, CLIP_DRAWING_MIN_PX).hairline).toBe(false);
    expect(clipDrawing(400, CLIP_DRAWING_MIN_PX - 0.001).hairline).toBe(true);
  });

  it("treats a width it cannot use as no width at all", () => {
    // A NaN reaches here from geometry that has not settled (a zero `pxPerMs` on the first
    // frame). It must not smuggle a box through a `Math.max`, and it must not become a NaN
    // in a style attribute, which voids the declaration silently.
    for (const bad of [NaN, -1, -Infinity]) {
      expect(clipDrawing(bad, Number.POSITIVE_INFINITY).width).toBe(HAIRLINE_WIDTH_PX);
    }
    // A NaN ROOM is "no neighbour measured", which is the same as no neighbour.
    expect(clipDrawing(400, NaN)).toEqual({ width: 400, hairline: false });
  });

  it("leaves no adjacent pair overlapping, at any zoom", () => {
    // The review's measurement, as an invariant: at fit zoom on the wedding, 309 of 340
    // adjacent pairs were drawn on top of one another. `stackClips` guarantees the SPANS do
    // not overlap; what broke it was the floors. Walk a dense row at zooms from "the whole
    // day in a thousand pixels" to "one clip fills the screen" and require that every box
    // ends at or before the next box begins.
    const row = Array.from({ length: 120 }, (_, i) => clip(`c${i}`, i * 90_000, 88_000));
    for (const pxPerMs of [0.0000042, 0.00004, 0.0004, 0.004, 0.04, 1]) {
      const view: TimelineView = { pxPerMs, scrollMs: 0, widthPx: 1000 };
      const boxes = clipBoxes([track(row)], view, LANE);
      for (let i = 0; i < row.length - 1; i++) {
        const here = boxes.get(row[i].file)!;
        const next = boxes.get(row[i + 1].file)!;
        expect(here.x + here.width, `pair ${i} at ${pxPerMs} px/ms`).toBeLessThanOrEqual(
          next.x + 1e-9,
        );
      }
    }
  });
});

describe("roomBeforeNext", () => {
  it("measures start to start, not end to start", () => {
    // The clamp is on the box's RIGHT EDGE measured from its own LEFT edge, and the left
    // edge is `msToX(startMs)` — so the room is the distance between the two STARTS. Taking
    // it from this clip's end would be a number that is already the answer to a different
    // question (the gap) and would clamp every clip to zero.
    expect(roomBeforeNext(clip("a", 1000, 100), clip("b", 1400), 1)).toBe(400);
    expect(roomBeforeNext(clip("a", 1000, 100), clip("b", 1400), 0.5)).toBe(200);
  });

  it("is infinite for the last clip in a row", () => {
    expect(roomBeforeNext(clip("a", 1000), undefined, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("hopExits", () => {
  it("returns the old box of a clip the new layout does not draw", () => {
    const before = [track([clip("a", 0)]), track([clip("gone", 700, 300)])];
    const after = [track([clip("a", 0)])];
    const exits = hopExits(before, VIEW, LANE, after);
    expect([...exits.keys()]).toEqual(["gone"]);
    expect(exits.get("gone")).toEqual({ x: 700, y: 5 + LANE, width: 300, hairline: false });
  });

  it("finds a survivor wherever it moved to", () => {
    const before = [track([clip("a", 0)]), track([clip("b", 0)])];
    const after = [track([clip("b", 0), clip("a", 500)])];
    expect(hopExits(before, VIEW, LANE, after).size).toBe(0);
  });

  it("is empty when nothing left, and everything when nothing stayed", () => {
    const before = [track([clip("a", 0)])];
    expect(hopExits(before, VIEW, LANE, before).size).toBe(0);
    expect(hopExits(before, VIEW, LANE, []).size).toBe(1);
    expect(hopExits([], VIEW, LANE, before).size).toBe(0);
  });
});

// ── V06 (D-090): the shuffle's choreography ────────────────────────────────────────────
//
// The motion is CSS and cannot be unit-tested; what CAN be, and is the part that would go
// quietly wrong, is the arithmetic that decides how long each clip waits and how far it
// wanders. Two properties carry the design:
//
//   - it is SEEDED, so the same drop choreographs identically every run — which is what
//     lets `e2e/hop.spec.ts` assert a distribution at all, and what stops a re-render
//     mid-flight from re-rolling a clip's numbers and jerking it sideways;
//   - it is BOUNDED, in both axes and in time, and the bounds are what keep «litt rundt»
//     from becoming a clip that visits another track.

/** The fixture's shape: enough distinct paths that a claim about spread means something. */
const FILES = Array.from({ length: 200 }, (_, i) => `/Users/e2e/shoot/CamA/C${1000 + i}.MP4`);

/** A comfortable clip — wide enough that the width cap never binds. */
const WIDE = 400;

describe("hopChoreography", () => {
  it("gives the same file the same number every time it is asked", () => {
    const once = hopChoreography(FILES[0], WIDE);
    for (let i = 0; i < 5; i++) expect(hopChoreography(FILES[0], WIDE)).toEqual(once);
  });

  it("is a function of the path, not of call order", () => {
    // Drawn in one order…
    const forwards = FILES.map((f) => hopChoreography(f, WIDE));
    // …and in the other. A generator threaded through the loop — the obvious way to write
    // this, and the wrong one — would give every clip a different number here.
    const backwards = [...FILES].reverse().map((f) => hopChoreography(f, WIDE));
    expect(backwards.reverse()).toEqual(forwards);
  });

  it("keeps every start delay inside the window the band's hold is sized from", () => {
    for (const file of FILES) {
      const { delayMs } = hopChoreography(file, WIDE);
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(HOP_MAX_DELAY_MS);
    }
    // …and that window plus one clip's travel IS the number's length, which is the constant
    // `useHop`'s safety net and App's band hold are both sized from. If these three ever
    // disagree the band leaves while the clips are still moving (D-082).
    expect(HOP_TOTAL_MS).toBe(HOP_MAX_DELAY_MS + HOP_TRAVEL_MS);
  });

  it("spreads the delays out, rather than handing a card's clips one shared number", () => {
    // Consecutive filenames off one camera card differ in a single character, which is
    // exactly the case a weak hash collapses — and a card whose forty clips all start
    // together is not a wave, it is a block moving.
    const delays = new Set(FILES.map((f) => hopChoreography(f, WIDE).delayMs));
    expect(delays.size).toBeGreaterThan(50);
    // Both ends of the window are actually used: nothing starts at once, nothing is left
    // straggling alone.
    const values = FILES.map((f) => hopChoreography(f, WIDE).delayMs);
    expect(Math.min(...values)).toBeLessThan(HOP_MAX_DELAY_MS * 0.15);
    expect(Math.max(...values)).toBeGreaterThan(HOP_MAX_DELAY_MS * 0.85);
  });

  it("wanders in both directions, and never nowhere", () => {
    const xs = FILES.map((f) => hopChoreography(f, WIDE).jx);
    const ys = FILES.map((f) => hopChoreography(f, WIDE).jy);
    expect(xs.some((x) => x < 0)).toBe(true);
    expect(xs.some((x) => x > 0)).toBe(true);
    expect(ys.some((y) => y < 0)).toBe(true);
    expect(ys.some((y) => y > 0)).toBe(true);
    // A wander that came out at 0.2 px is a clip standing still while its neighbours dance,
    // which reads as a bug rather than as variety. The floor is 40 % of the reach — less the
    // half-tenth the rounding to one decimal is allowed to shave off it.
    const ROUNDING = 0.05;
    for (const x of xs) {
      expect(Math.abs(x)).toBeGreaterThanOrEqual(HOP_JITTER_X_PX * 0.4 - ROUNDING);
    }
    for (const y of ys) {
      expect(Math.abs(y)).toBeGreaterThanOrEqual(HOP_JITTER_Y_PX * 0.4 - ROUNDING);
    }
  });

  it("stays inside its own bounds, so a shiver never becomes a lane change", () => {
    for (const file of FILES) {
      const { jx, jy } = hopChoreography(file, WIDE);
      expect(Math.abs(jx)).toBeLessThanOrEqual(HOP_JITTER_X_PX);
      // The vertical reach is a small fraction of the TIGHTEST lane — 3 px inside 40 —
      // because a clip that wandered a lane's worth would read as having changed track and
      // come back. Stated against the floor because that is the worst case: a lane that has
      // grown only gives the same shiver more room.
      expect(Math.abs(jy)).toBeLessThanOrEqual(HOP_JITTER_Y_PX);
      expect(HOP_JITTER_Y_PX * 2).toBeLessThan(LANE / 4);
    }
  });

  it("scales the wander down to a sliver's own width, and no further than the floor", () => {
    // The wedding case: 386 clips at HAIRLINE_WIDTH_PX. A 2 px tick wandering ±8 px moves
    // four times its own width in 140 ms, which the eye reads as flicker — or as a clip that
    // jumped somewhere else and back. Capped at its own width, it shivers.
    for (const file of FILES) {
      const { jx } = hopChoreography(file, HAIRLINE_WIDTH_PX);
      expect(Math.abs(jx)).toBeLessThanOrEqual(HAIRLINE_WIDTH_PX);
    }
    // …but never below the floor, or the narrowest clips would be the only ones not moving.
    for (const file of FILES) {
      expect(Math.abs(hopChoreography(file, 0).jx)).toBeGreaterThanOrEqual(
        HOP_MIN_JITTER_X_PX * 0.4 - 0.05,
      );
      expect(Math.abs(hopChoreography(file, 0).jx)).toBeLessThanOrEqual(HOP_MIN_JITTER_X_PX);
    }
    // The cap binds on narrow clips and lets go on wide ones — the same file, two widths.
    expect(Math.abs(hopChoreography(FILES[0], HAIRLINE_WIDTH_PX).jx)).toBeLessThan(
      Math.abs(hopChoreography(FILES[0], WIDE).jx),
    );
  });

  it("leaves the vertical wander alone at every width", () => {
    // Every clip is the same height, so there is nothing for the vertical reach to be out of
    // proportion with — and a `jy` that shrank with the WIDTH would be arithmetic that had
    // quietly started answering a different question.
    for (const width of [0, HAIRLINE_WIDTH_PX, 12, WIDE]) {
      expect(hopChoreography(FILES[3], width).jy).toBe(hopChoreography(FILES[3], WIDE).jy);
    }
  });

  it("survives the paths a POSIX file name is actually allowed to have", () => {
    // The hash walks the string, so an empty name, a very long one, and one full of
    // punctuation and non-ASCII all have to come out as ordinary numbers rather than as NaN
    // — a NaN would land in a CSS custom property and silently void the whole transform.
    const awkward = ["", "/a", "/Users/e2e/Bryllup «Ø»/C0001 (kopi) [2].MP4", "x".repeat(4096)];
    for (const file of awkward) {
      const { delayMs, jx, jy } = hopChoreography(file, WIDE);
      expect(Number.isFinite(delayMs)).toBe(true);
      expect(Number.isFinite(jx)).toBe(true);
      expect(Number.isFinite(jy)).toBe(true);
      expect(delayMs).toBeLessThanOrEqual(HOP_MAX_DELAY_MS);
    }
  });
});
