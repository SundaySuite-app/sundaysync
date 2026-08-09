// Adapted from SundayEdit (same owner) — src/features/timeline/geometry.test.ts; see docs/DECISIONS.md D-051.
import { describe, it, expect } from "vitest";
import {
  clampZoom,
  msToX,
  xToMs,
  visibleRange,
  zoomAround,
  visibleClips,
  tickIntervalMs,
  rulerTicks,
  formatTimecode,
  MIN_PX_PER_MS,
  MAX_PX_PER_MS,
  type TimelineView,
} from "./geometry";

const view: TimelineView = { pxPerMs: 0.1, scrollMs: 1000, widthPx: 800 };

describe("time ↔ pixel mapping", () => {
  it("round-trips ms → x → ms", () => {
    expect(msToX(1000, view)).toBe(0); // scrollMs at x=0
    expect(msToX(2000, view)).toBeCloseTo(100);
    expect(xToMs(msToX(3456, view), view)).toBeCloseTo(3456);
  });

  it("computes the visible range from width and zoom", () => {
    // 800px / 0.1 px/ms = 8000ms span, starting at scrollMs.
    expect(visibleRange(view)).toEqual([1000, 9000]);
  });
});

describe("zoom", () => {
  it("clamps to bounds", () => {
    expect(clampZoom(99)).toBe(MAX_PX_PER_MS);
    expect(clampZoom(0)).toBe(MIN_PX_PER_MS);
  });

  it("keeps the time under the anchor pixel fixed", () => {
    const anchorX = 300;
    const anchorMsBefore = xToMs(anchorX, view);
    const zoomed = zoomAround(view, 2, anchorX);
    expect(zoomed.pxPerMs).toBeCloseTo(0.2);
    // Same time still sits under the same pixel.
    expect(xToMs(anchorX, zoomed)).toBeCloseTo(anchorMsBefore);
  });

  it("never scrolls before zero", () => {
    const z = zoomAround({ ...view, scrollMs: 0 }, 0.5, 0);
    expect(z.scrollMs).toBeGreaterThanOrEqual(0);
  });
});

describe("visibleClips virtualization", () => {
  const clips = Array.from({ length: 1000 }, (_, i) => ({
    file: `c${i}.mov`,
    startMs: i * 1000,
    endMs: i * 1000 + 800,
  }));

  it("returns only the window around [start,end] plus buffer", () => {
    const vis = visibleClips(clips, 500_000, 503_000, 5);
    const indices = vis.map((v) => v.index);
    // Window is clips 500..503; buffer 5 each side.
    expect(Math.min(...indices)).toBe(495);
    expect(Math.max(...indices)).toBe(508);
    expect(vis.length).toBeLessThan(20); // nowhere near all 1000
  });

  it("clamps the buffer at the start of the list", () => {
    const vis = visibleClips(clips, 0, 1500, 5);
    expect(vis[0].index).toBe(0);
  });

  it("handles a window past the end", () => {
    const vis = visibleClips(clips, 2_000_000, 2_001_000, 5);
    expect(vis.every((v) => v.index < clips.length)).toBe(true);
  });

  it("is a no-op with no clips", () => {
    expect(visibleClips([], 0, 1000)).toEqual([]);
  });
});

describe("ruler", () => {
  it("picks a coarser interval as you zoom out", () => {
    const zoomedIn = tickIntervalMs({ ...view, pxPerMs: 1 }, 80);
    const zoomedOut = tickIntervalMs({ ...view, pxPerMs: 0.01 }, 80);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it("spaces ticks at least minPxBetween apart", () => {
    const v = { ...view, pxPerMs: 0.1 };
    const interval = tickIntervalMs(v, 80);
    expect(interval * v.pxPerMs).toBeGreaterThanOrEqual(80);
  });

  it("generates ticks across the visible range", () => {
    const ticks = rulerTicks(view, 80);
    const [start, end] = visibleRange(view);
    expect(ticks.every((t) => t >= start && t <= end)).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
  });
});

describe("formatTimecode", () => {
  it("formats MM:SS.mmm under an hour", () => {
    expect(formatTimecode(0)).toBe("00:00.000");
    expect(formatTimecode(65_500)).toBe("01:05.500");
  });

  it("adds hours past 60 minutes", () => {
    expect(formatTimecode(3_661_000)).toBe("1:01:01.000");
  });

  it("keeps sub-frame millisecond precision instead of rounding to a frame", () => {
    expect(formatTimecode(999)).toBe("00:00.999");
    expect(formatTimecode(1_499)).toBe("00:01.499");
  });

  it("clamps negative input to zero", () => {
    expect(formatTimecode(-500)).toBe("00:00.000");
  });
});
