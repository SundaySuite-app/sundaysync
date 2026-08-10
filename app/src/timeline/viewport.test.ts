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

  it("both ends of travel are exact: 0 at the start, flush right at the end", () => {
    const span = 4_000_000;
    const v = view();
    const visibleMs = v.widthPx / v.pxPerMs;
    const start = scrollbarMetrics({ ...v, scrollMs: 0 }, span);
    const end = scrollbarMetrics({ ...v, scrollMs: span - visibleMs }, span);
    expect(start.offsetFrac).toBe(0);
    expect(end.offsetFrac + end.thumbFrac).toBeCloseTo(1, 12);
  });

  it("the thumb keeps moving over the last stretch at deep zoom (finding 10)", () => {
    // 3 hours at maximum zoom: the visible window is 0.00005 of the content, so
    // `thumbFrac` is inflated to its 0.02 floor. Expressing the offset as a fraction of
    // the CONTENT then runs past the end of the thumb's travel, and the old
    // `Math.min(1 - thumbFrac, …)` clamp pinned it there — measured at 0.9800 for both
    // 99 % and 100 % of maximum scroll, i.e. a thumb frozen across the last ~4 minutes
    // while the timeline underneath kept scrolling.
    const span = 3 * 3_600_000;
    const v = view({ pxPerMs: MAX_PX_PER_MS, widthPx: 1000 });
    const maxScroll = span - v.widthPx / v.pxPerMs;

    const at99 = scrollbarMetrics({ ...v, scrollMs: maxScroll * 0.99 }, span);
    const atEnd = scrollbarMetrics({ ...v, scrollMs: maxScroll }, span);
    expect(at99.thumbFrac).toBe(0.02);
    expect(atEnd.offsetFrac).toBeGreaterThan(at99.offsetFrac + 0.005);
    expect(atEnd.offsetFrac).toBeCloseTo(0.98, 12);

    // ...and it is strictly monotonic the whole way, never stalling anywhere.
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const m = scrollbarMetrics({ ...v, scrollMs: (maxScroll * i) / 100 }, span);
      expect(m.offsetFrac).toBeGreaterThan(previous);
      expect(m.offsetFrac + m.thumbFrac).toBeLessThanOrEqual(1 + 1e-12);
      previous = m.offsetFrac;
    }
  });

  it("pins to zero rather than dividing by it when everything already fits", () => {
    const m = scrollbarMetrics(view({ scrollMs: 999 }), 500_000);
    expect(m.thumbFrac).toBe(1);
    expect(m.offsetFrac).toBe(0);
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
