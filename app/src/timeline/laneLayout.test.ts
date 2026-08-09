// Adapted from SundayEdit (same owner) — src/features/timeline/laneLayout.test.ts; see docs/DECISIONS.md D-051.
import { describe, it, expect } from "vitest";
import { stackClips, trackAtY, type ClipSpan } from "./laneLayout";

function span(file: string, startMs: number, endMs: number): ClipSpan {
  return { file, startMs, endMs };
}

describe("stackClips", () => {
  it("keeps non-overlapping clips in a single row", () => {
    const rows = stackClips([
      span("a.mov", 0, 1000),
      span("b.mov", 1500, 2500),
      span("c.mov", 3000, 4000),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].map((c) => c.file)).toEqual(["a.mov", "b.mov", "c.mov"]);
  });

  it("stacks two overlapping clips into two rows", () => {
    const rows = stackClips([span("a.mov", 0, 1000), span("b.mov", 500, 1500)]);
    expect(rows.length).toBe(2);
    expect(rows[0].map((c) => c.file)).toEqual(["a.mov"]);
    expect(rows[1].map((c) => c.file)).toEqual(["b.mov"]);
  });

  it("does not stack clips that only touch at an endpoint", () => {
    // b starts exactly when a ends — not an overlap, so it shares a's row.
    const rows = stackClips([span("a.mov", 0, 1000), span("b.mov", 1000, 2000)]);
    expect(rows.length).toBe(1);
    expect(rows[0].map((c) => c.file)).toEqual(["a.mov", "b.mov"]);
  });

  it("stacks three mutually overlapping clips into three rows", () => {
    const rows = stackClips([
      span("a.mov", 0, 3000),
      span("b.mov", 1000, 4000),
      span("c.mov", 2000, 5000),
    ]);
    expect(rows.map((r) => r.map((c) => c.file))).toEqual([
      ["a.mov"],
      ["b.mov"],
      ["c.mov"],
    ]);
  });

  it("reuses a row once its last clip has ended, even with a later overlap elsewhere", () => {
    // a:[0,1000) -> row0. b:[500,1500) overlaps a -> row1.
    // c:[1000,2000) doesn't overlap a (touches) -> fits row0 before row1 is tried.
    const rows = stackClips([
      span("a.mov", 0, 1000),
      span("b.mov", 500, 1500),
      span("c.mov", 1000, 2000),
    ]);
    expect(rows.map((r) => r.map((c) => c.file))).toEqual([
      ["a.mov", "c.mov"],
      ["b.mov"],
    ]);
  });

  it("sorts input by startMs regardless of input order", () => {
    const rows = stackClips([span("b.mov", 1000, 2000), span("a.mov", 0, 1000)]);
    expect(rows).toEqual([[span("a.mov", 0, 1000), span("b.mov", 1000, 2000)]]);
  });

  it("returns no rows for empty input", () => {
    expect(stackClips([])).toEqual([]);
  });
});

describe("trackAtY", () => {
  const rows = stackClips([span("a.mov", 0, 1000), span("b.mov", 500, 1500)]);

  it("resolves a Y to the row via row height", () => {
    expect(trackAtY(0, rows, 48)?.map((c) => c.file)).toEqual(["a.mov"]);
    expect(trackAtY(47, rows, 48)?.map((c) => c.file)).toEqual(["a.mov"]); // last px of row 0
    expect(trackAtY(48, rows, 48)?.map((c) => c.file)).toEqual(["b.mov"]); // row boundary -> row 1
    expect(trackAtY(999, rows, 48)).toBeNull();
  });

  it("returns null above the rows area, with no rows, or degenerate row height", () => {
    expect(trackAtY(-1, rows, 48)).toBeNull();
    expect(trackAtY(2 * 48, rows, 48)).toBeNull(); // just past the last row
    expect(trackAtY(0, [], 48)).toBeNull();
    expect(trackAtY(0, rows, 0)).toBeNull();
  });
});
