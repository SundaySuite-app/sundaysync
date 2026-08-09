// Adapted from SundayEdit (same owner) — src/features/timeline/laneLayout.edge.test.ts; see docs/DECISIONS.md D-051.
/**
 * laneLayout — edge branches on top of laneLayout.test.ts: does-not-mutate
 * the input, and degenerate/out-of-range row-height hit-testing.
 */
import { describe, it, expect } from "vitest";
import { stackClips, trackAtY, type ClipSpan } from "./laneLayout";

function span(file: string, startMs: number, endMs: number): ClipSpan {
  return { file, startMs, endMs };
}

describe("stackClips — does not mutate input", () => {
  it("leaves the input array in its original order", () => {
    const clips = [span("b.mov", 1000, 2000), span("a.mov", 0, 1000)];
    stackClips(clips);
    expect(clips.map((c) => c.file)).toEqual(["b.mov", "a.mov"]);
  });
});

describe("trackAtY — degenerate row height", () => {
  it("returns null for a negative row height instead of hit-testing garbage", () => {
    expect(trackAtY(0, [[span("a.mov", 0, 1000)]], -48)).toBeNull();
  });

  it("returns null exactly at the boundary past the last row", () => {
    const rows = stackClips([span("a.mov", 0, 1000), span("b.mov", 500, 1500)]);
    expect(rows.length).toBe(2);
    expect(trackAtY(2 * 48, rows, 48)).toBeNull();
    expect(trackAtY(1 * 48 + 47, rows, 48)?.map((c) => c.file)).toEqual(["b.mov"]);
  });
});
