import { describe, expect, it } from "vitest";
import type { TimelineView } from "./geometry";
import {
  CLIP_HEIGHT_PX,
  LANE_HEIGHT_PX,
  MIN_CLIP_WIDTH_PX,
  clipBoxes,
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
