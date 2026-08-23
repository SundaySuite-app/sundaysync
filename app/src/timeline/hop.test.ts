import { describe, expect, it } from "vitest";
import type { TimelineView } from "./geometry";
import {
  CLIP_HEIGHT_PX,
  HOP_JITTER_X_PX,
  HOP_JITTER_Y_PX,
  HOP_MAX_DELAY_MS,
  HOP_MIN_JITTER_X_PX,
  HOP_TOTAL_MS,
  HOP_TRAVEL_MS,
  LANE_HEIGHT_PX,
  MIN_CLIP_WIDTH_PX,
  clipBoxes,
  hopChoreography,
  hopDeltas,
  hopExits,
  type HopTrack,
} from "./hop";

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
    const boxes = clipBoxes([track([clip("a", 0)])], VIEW);
    // 1 px track border + 1 px lane border + the clip's own 3 px inset.
    expect(boxes.get("a")).toEqual({ x: 0, y: 5, width: 100 });
  });

  it("stacks the second track below the first by the first track's full height", () => {
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])],
      VIEW,
    );
    expect(boxes.get("a")!.y).toBe(5);
    expect(boxes.get("b")!.y).toBe(5 + LANE_HEIGHT_PX);
    // Two lanes above, so the second track starts two lane heights down.
    expect(boxes.get("c")!.y).toBe(5 + 2 * LANE_HEIGHT_PX);
  });

  it("gives an empty track one lane's worth of height anyway (§7.5)", () => {
    const boxes = clipBoxes([track(), track([clip("a", 0)])], VIEW);
    expect(boxes.get("a")!.y).toBe(5 + LANE_HEIGHT_PX);
  });

  it("maps x through the view, pan and zoom included", () => {
    const zoomed: TimelineView = { pxPerMs: 0.5, scrollMs: 200, widthPx: 1000 };
    const boxes = clipBoxes([track([clip("a", 1000, 400)])], zoomed);
    expect(boxes.get("a")).toEqual({ x: (1000 - 200) * 0.5, y: 5, width: 200 });
  });

  it("floors a zero-length clip at the width the component draws it at", () => {
    const boxes = clipBoxes([track([clip("a", 500, 0)])], VIEW);
    expect(boxes.get("a")!.width).toBe(MIN_CLIP_WIDTH_PX);
  });

  it("is empty for no tracks, and for tracks with no clips", () => {
    expect(clipBoxes([], VIEW).size).toBe(0);
    expect(clipBoxes([track(), track()], VIEW).size).toBe(0);
  });

  // ── V06-R2b (D-083): the row pitch is ONE number, and this is where it is checked ────
  //
  // `LANE_HEIGHT_PX` went 34 → 40 so the gutter could carry two lines. Everything vertical
  // in the timeline is that constant times an integer: `Track.tsx` sizes the track and each
  // lane from it, `clipBoxes` sums it, `useHop` places ghosts by it. The risk the stage
  // carried is a lane the browser grew — a `min-height` on the two-line gutter taller than
  // the constant — because then the DOM's pitch and this module's pitch disagree by a few
  // px per track and every clip below the first one hops to a row it is not in. Nothing
  // here can see the DOM, so what these two assert is the other half: that the arithmetic
  // is the constant and nothing but the constant, at any value it is ever given.

  it("puts consecutive rows of one track exactly one LANE_HEIGHT_PX apart", () => {
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)], [clip("c", 0)])],
      VIEW,
    );
    const [a, b, c] = [boxes.get("a")!.y, boxes.get("b")!.y, boxes.get("c")!.y];
    expect(b - a).toBe(LANE_HEIGHT_PX);
    expect(c - b).toBe(LANE_HEIGHT_PX);
  });

  it("starts a two-lane track's second row at exactly trackTop + LANE_HEIGHT_PX", () => {
    // `trackTop` is not a number this module exports, so it is taken the only way a caller
    // could: the first row of a track IS its top plus the two hairlines and the inset, and
    // a following track's top is the previous one's top plus its lanes. One track of two
    // lanes, then a second track — so both readings of "trackTop" are exercised at once.
    const boxes = clipBoxes(
      [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])],
      VIEW,
    );
    const trackTop = boxes.get("a")!.y;
    expect(boxes.get("b")!.y).toBe(trackTop + LANE_HEIGHT_PX);
    // …and the next track begins after exactly two of them, never after "two plus whatever
    // the gutter needed".
    expect(boxes.get("c")!.y).toBe(trackTop + 2 * LANE_HEIGHT_PX);
  });

  it("leaves room inside a lane for the clip it describes", () => {
    // The ghosts are drawn CLIP_HEIGHT_PX tall at these positions; if the constant and the
    // lane height ever drift, a ghost stops matching the clip beside it.
    expect(CLIP_HEIGHT_PX).toBeLessThan(LANE_HEIGHT_PX);
    expect(CLIP_HEIGHT_PX).toBe(LANE_HEIGHT_PX - 1 - 2 * 3);
  });
});

describe("hopDeltas", () => {
  it("carries a clip that moved along its own track", () => {
    const before = [track([clip("a", 1000)])];
    const after = [track([clip("a", 1400)])];
    // The clip is drawn 400 px further right, so it starts 400 px to the LEFT of there.
    expect(hopDeltas(before, VIEW, after, VIEW).get("a")).toEqual({ dx: -400, dy: 0 });
  });

  it("reports a zero delta for a clip that did not move", () => {
    const same = [track([clip("a", 1000)])];
    expect(hopDeltas(same, VIEW, same, VIEW).get("a")).toEqual({ dx: 0, dy: 0 });
  });

  it("carries a clip that changed track", () => {
    const before = [track([clip("a", 0)]), track([clip("b", 0)])];
    const after = [track([clip("b", 0)]), track([clip("a", 0)])];
    const deltas = hopDeltas(before, VIEW, after, VIEW);
    // `a` was on the first row and is now on the second: it starts one lane HIGHER than
    // where it now lives, and `b` starts one lane lower.
    expect(deltas.get("a")).toEqual({ dx: 0, dy: -LANE_HEIGHT_PX });
    expect(deltas.get("b")).toEqual({ dx: 0, dy: LANE_HEIGHT_PX });
  });

  it("shifts everything below a track that gained a lane", () => {
    const before = [track([clip("a", 0)]), track([clip("c", 0)])];
    // The first track now stacks two rows — its own second clip, and every track under it,
    // move down by a lane.
    const after = [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])];
    const deltas = hopDeltas(before, VIEW, after, VIEW);
    expect(deltas.get("a")).toEqual({ dx: 0, dy: 0 });
    expect(deltas.get("c")).toEqual({ dx: 0, dy: -LANE_HEIGHT_PX });
    // `b` is new — nothing to hop from.
    expect(deltas.has("b")).toBe(false);
  });

  it("shifts everything below a track that lost a lane", () => {
    const before = [track([clip("a", 0)], [clip("b", 0)]), track([clip("c", 0)])];
    const after = [track([clip("a", 0)]), track([clip("c", 0)])];
    expect(hopDeltas(before, VIEW, after, VIEW).get("c")).toEqual({
      dx: 0,
      dy: LANE_HEIGHT_PX,
    });
  });

  it("ignores files that exist on only one side", () => {
    const before = [track([clip("gone", 0)])];
    const after = [track([clip("new", 0)])];
    expect(hopDeltas(before, VIEW, after, VIEW).size).toBe(0);
  });

  it("is empty when either side has nothing to draw", () => {
    const some = [track([clip("a", 0)])];
    expect(hopDeltas([], VIEW, some, VIEW).size).toBe(0);
    expect(hopDeltas(some, VIEW, [], VIEW).size).toBe(0);
    expect(hopDeltas([], VIEW, [], VIEW).size).toBe(0);
  });

  it("measures each side under its own view when the two differ", () => {
    const before = [track([clip("a", 1000)])];
    const after = [track([clip("a", 1000)])];
    const zoomedOut: TimelineView = { pxPerMs: 0.5, scrollMs: 0, widthPx: 1000 };
    // Same timeline position, half the zoom: the box is drawn at 500 instead of 1000, so
    // it would have to start 500 px to the right of its new home.
    expect(hopDeltas(before, VIEW, after, zoomedOut).get("a")).toEqual({ dx: 500, dy: 0 });
  });
});

describe("hopExits", () => {
  it("returns the old box of a clip the new layout does not draw", () => {
    const before = [track([clip("a", 0)]), track([clip("gone", 700, 300)])];
    const after = [track([clip("a", 0)])];
    const exits = hopExits(before, VIEW, after);
    expect([...exits.keys()]).toEqual(["gone"]);
    expect(exits.get("gone")).toEqual({ x: 700, y: 5 + LANE_HEIGHT_PX, width: 300 });
  });

  it("finds a survivor wherever it moved to", () => {
    const before = [track([clip("a", 0)]), track([clip("b", 0)])];
    const after = [track([clip("b", 0), clip("a", 500)])];
    expect(hopExits(before, VIEW, after).size).toBe(0);
  });

  it("is empty when nothing left, and everything when nothing stayed", () => {
    const before = [track([clip("a", 0)])];
    expect(hopExits(before, VIEW, before).size).toBe(0);
    expect(hopExits(before, VIEW, []).size).toBe(1);
    expect(hopExits([], VIEW, before).size).toBe(0);
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
      // The vertical reach is a small fraction of a lane — 3 px inside 40 — because a clip
      // that wandered a lane's worth would read as having changed track and come back.
      expect(Math.abs(jy)).toBeLessThanOrEqual(HOP_JITTER_Y_PX);
      expect(HOP_JITTER_Y_PX * 2).toBeLessThan(LANE_HEIGHT_PX / 4);
    }
  });

  it("scales the wander down to a sliver's own width, and no further than the floor", () => {
    // The wedding case: 386 clips at MIN_CLIP_WIDTH_PX. A 3 px box wandering ±8 px moves
    // nearly three times its own width in 140 ms, which the eye reads as flicker — or as a
    // clip that jumped somewhere else and back. Capped at its own width, it shivers.
    for (const file of FILES) {
      const { jx } = hopChoreography(file, MIN_CLIP_WIDTH_PX);
      expect(Math.abs(jx)).toBeLessThanOrEqual(MIN_CLIP_WIDTH_PX);
    }
    // …but never below the floor, or the narrowest clips would be the only ones not moving.
    for (const file of FILES) {
      expect(Math.abs(hopChoreography(file, 0).jx)).toBeGreaterThanOrEqual(
        HOP_MIN_JITTER_X_PX * 0.4 - 0.05,
      );
      expect(Math.abs(hopChoreography(file, 0).jx)).toBeLessThanOrEqual(HOP_MIN_JITTER_X_PX);
    }
    // The cap binds on narrow clips and lets go on wide ones — the same file, two widths.
    expect(Math.abs(hopChoreography(FILES[0], MIN_CLIP_WIDTH_PX).jx)).toBeLessThan(
      Math.abs(hopChoreography(FILES[0], WIDE).jx),
    );
  });

  it("leaves the vertical wander alone at every width", () => {
    // Every clip is the same height, so there is nothing for the vertical reach to be out of
    // proportion with — and a `jy` that shrank with the WIDTH would be arithmetic that had
    // quietly started answering a different question.
    for (const width of [0, MIN_CLIP_WIDTH_PX, 12, WIDE]) {
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
