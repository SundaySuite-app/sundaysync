import { describe, expect, it } from "vitest";
import { MAX_PX_PER_MS, MIN_PX_PER_MS, type TimelineView } from "./geometry";
import {
  clampScroll,
  contentBounds,
  fitPxPerMs,
  scrollbarFracToScrollMs,
  scrollbarMetrics,
} from "./viewport";

const view = (over: Partial<TimelineView> = {}): TimelineView => ({
  pxPerMs: 0.001,
  scrollMs: 0,
  widthPx: 1000,
  ...over,
});

describe("contentBounds", () => {
  it("an empty result still spans something divisible", () => {
    expect(contentBounds([])).toEqual({ originMs: 0, spanMs: 1 });
  });

  it("keeps the origin at zero when nothing precedes the reference", () => {
    const b = contentBounds([
      { startMs: 4_200, endMs: 3_554_200 },
      { startMs: 0, endMs: 3_600_000 },
    ]);
    // Origin unshifted: the ruler then reads real offset_seconds.
    expect(b.originMs).toBe(0);
    expect(b.spanMs).toBe(3_600_000);
  });

  it("shifts the origin so a clip that started before the reference stays visible", () => {
    const b = contentBounds([
      { startMs: -5_000, endMs: 1_000 },
      { startMs: 0, endMs: 10_000 },
    ]);
    expect(b.originMs).toBe(-5_000);
    expect(b.spanMs).toBe(15_000);
  });

  it("never returns a zero span for a zero-length clip", () => {
    expect(contentBounds([{ startMs: 0, endMs: 0 }]).spanMs).toBe(1);
  });
});

describe("fitPxPerMs", () => {
  it("shows the whole span with padding to spare", () => {
    const pxPerMs = fitPxPerMs(100_000, 1000, 24);
    expect(100_000 * pxPerMs).toBeCloseTo(976, 6);
    expect(100_000 * pxPerMs).toBeLessThan(1000);
  });

  it("stays inside the zoom bounds for absurd content", () => {
    // 100 hours across a narrow window would want a zoom below the floor.
    expect(fitPxPerMs(360_000_000, 400)).toBe(MIN_PX_PER_MS);
    // A 2 ms result would want a zoom above the ceiling.
    expect(fitPxPerMs(2, 1200)).toBe(MAX_PX_PER_MS);
  });

  it("survives a viewport narrower than its own padding", () => {
    expect(fitPxPerMs(10_000, 10, 24)).toBeGreaterThan(0);
  });
});

describe("clampScroll", () => {
  it("never scrolls before the start", () => {
    expect(clampScroll(-500, 0.001, 1000, 60_000)).toBe(0);
  });

  it("stops with the last content at the right edge", () => {
    // 1000px @ 0.001 px/ms = 1_000_000 ms visible; content 1_500_000 ms.
    expect(clampScroll(9_999_999, 0.001, 1000, 1_500_000)).toBe(500_000);
  });

  it("pins to zero when everything already fits", () => {
    expect(clampScroll(400, 0.001, 1000, 500_000)).toBe(0);
  });
});

describe("scrollbarMetrics", () => {
  it("fills the trough when the whole timeline is visible", () => {
    const m = scrollbarMetrics(view({ pxPerMs: 0.001 }), 500_000);
    expect(m.thumbFrac).toBe(1);
    expect(m.offsetFrac).toBe(0);
  });

  it("is proportional to the visible fraction", () => {
    // 1_000_000 ms visible of 4_000_000 ms total = a quarter.
    const m = scrollbarMetrics(view(), 4_000_000);
    expect(m.thumbFrac).toBeCloseTo(0.25, 10);
    expect(m.offsetFrac).toBe(0);
  });

  it("tracks the scroll position and never overhangs the trough", () => {
    const m = scrollbarMetrics(view({ scrollMs: 3_000_000 }), 4_000_000);
    expect(m.offsetFrac + m.thumbFrac).toBeLessThanOrEqual(1);
    expect(m.offsetFrac).toBeCloseTo(0.75, 10);
  });

  it("keeps the thumb grabbable at extreme zoom", () => {
    const m = scrollbarMetrics(view({ pxPerMs: 1 }), 36_000_000);
    expect(m.thumbFrac).toBeGreaterThanOrEqual(0.02);
  });
});

describe("scrollbarFracToScrollMs", () => {
  it("centres the visible window on the grabbed point", () => {
    // 1_000_000 ms visible; grabbing the middle of a 4_000_000 ms timeline.
    expect(scrollbarFracToScrollMs(0.5, view(), 4_000_000)).toBe(1_500_000);
  });

  it("clamps at both ends", () => {
    expect(scrollbarFracToScrollMs(0, view(), 4_000_000)).toBe(0);
    expect(scrollbarFracToScrollMs(1, view(), 4_000_000)).toBe(3_000_000);
  });
});
