// Adapted from SundayEdit (same owner) — src/features/timeline/laneLayout.edge.test.ts; see docs/DECISIONS.md D-051.
/**
 * laneLayout — edge branches on top of laneLayout.test.ts: the packing must not
 * mutate the array it is handed.
 *
 * (The `trackAtY` hit-testing cases that used to live here went with the function in
 * V03-S6 — see laneLayout.ts's note.)
 */
import { describe, it, expect } from "vitest";
import { stackClips, type ClipSpan } from "./laneLayout";

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

