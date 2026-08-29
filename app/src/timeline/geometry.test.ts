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
  tickLabel,
  TICK_CHAR_PX,
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

// ── The ladder, and the question it asks of every rung (V06-G3, D-092 ④) ──────────────────
//
// The old rule was «is the step at least 80 px?», the old ladder stopped at one hour, and the
// two failed together at exactly the zoom that matters most: over an 18-hour day in the lane
// the app actually has (736 px at 1280×800), an hour is 41 px, nothing answered yes, and the
// function fell off the end of its list and returned the hour anyway. Sixteen of eighteen
// labels then landed on top of the one before them.
//
// What collides is LABELS, so what is measured is labels: `step_px ≥ label_width + 16`, with
// the width estimated from the character count the same way `Ruler.tsx` estimates its own
// right-edge clipping. The lane width below is the real one; the zooms are the real ones.
describe("the tick ladder never lets two labels touch", () => {
  /** The lane the timeline actually has at 1280×800: window − inspector − gutter − chrome. */
  const LANE_PX = 736;
  const HOUR = 3_600_000;

  /** The view «Tilpass» produces for a drop of `spanMs`, near enough for a ruler. */
  const fitted = (spanMs: number): TimelineView => ({
    pxPerMs: LANE_PX / spanMs,
    scrollMs: 0,
    widthPx: LANE_PX,
  });

  /** The narrowest gap between one label's right edge and the next label's line, in px. */
  function tightestGapPx(v: TimelineView, originEpochMs: number | null = null): number {
    const interval = tickIntervalMs(v, 80, originEpochMs);
    const ticks = rulerTicks(v, 80, originEpochMs);
    let tightest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < ticks.length; i++) {
      const label = tickLabel(ticks[i - 1], interval, originEpochMs);
      const gap =
        msToX(ticks[i], v) - (msToX(ticks[i - 1], v) + 4 + label.length * TICK_CHAR_PX);
      tightest = Math.min(tightest, gap);
    }
    return tightest;
  }

  it("keeps clear space beside every label across a whole shoot day", () => {
    // The reported case, and the ones either side of it.
    for (const hours of [6, 10, 15.5, 18, 20]) {
      const v = fitted(hours * HOUR);
      expect(tightestGapPx(v), `${hours} h fitted`).toBeGreaterThan(0);
    }
  });

  it("keeps clear space at every rung, from milliseconds to half a day", () => {
    // A sweep rather than a handful of points: the ladder is only as good as its worst rung,
    // and a boundary is exactly where an off-by-one in the admission rule hides.
    for (let pxPerMs = MIN_PX_PER_MS; pxPerMs <= MAX_PX_PER_MS; pxPerMs *= 1.3) {
      const v: TimelineView = { pxPerMs, scrollMs: 0, widthPx: LANE_PX };
      expect(tightestGapPx(v), `pxPerMs ${pxPerMs}`).toBeGreaterThan(0);
    }
  });

  it("coarsens past the hour rather than falling off the end of the list", () => {
    // The mechanism, named. An 18-hour fit cannot use the hour, and the old ladder had
    // nothing above it to reach for.
    expect(tickIntervalMs(fitted(18 * HOUR), 80)).toBeGreaterThan(HOUR);
    // …and the top of the ladder is enough for the zoom floor: at ~20 h nothing above 12 h
    // is ever needed.
    expect(tickIntervalMs({ pxPerMs: MIN_PX_PER_MS, scrollMs: 0, widthPx: LANE_PX }, 80))
      .toBeLessThanOrEqual(12 * HOUR);
  });

  it("still climbs monotonically as the view zooms out", () => {
    let previous = 0;
    for (let pxPerMs = MAX_PX_PER_MS; pxPerMs >= MIN_PX_PER_MS; pxPerMs /= 2) {
      const interval = tickIntervalMs({ pxPerMs, scrollMs: 0, widthPx: LANE_PX }, 80);
      expect(interval).toBeGreaterThanOrEqual(previous);
      previous = interval;
    }
  });

  it("holds when the labels are wall clocks too", () => {
    // Wall-clock labels are five characters where an elapsed one can be eight, so the ladder
    // is allowed to be finer here — but never crowded.
    const origin = Date.parse("2026-08-15T06:00:00.000Z");
    for (const hours of [6, 18, 20]) {
      expect(tightestGapPx(fitted(hours * HOUR), origin), `${hours} h wall clock`).toBeGreaterThan(0);
    }
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

describe("tickLabel", () => {
  // V06-R3. `formatTimecode` is the transport's clock and always prints milliseconds; a
  // ruler at one tick per hour printed the same `.000` on every label, which is four
  // characters of nothing on the one row where a label's width decides whether the
  // rightmost tick can be drawn at all.
  it("keeps the milliseconds while a tick is under a second", () => {
    expect(tickLabel(1_234, 100)).toBe("00:01.234");
    expect(tickLabel(1_234, 500)).toBe("00:01.234");
  });

  it("drops them the moment no two ticks could differ in them", () => {
    expect(tickLabel(90_000, 1_000)).toBe("01:30");
    expect(tickLabel(3_600_000, 3_600_000)).toBe("1:00:00");
    expect(tickLabel(0, 60_000)).toBe("00:00");
  });

  it("drops exactly four characters and nothing else", () => {
    for (const ms of [0, 999, 3_599_999, 60 * 3_600_000]) {
      expect(tickLabel(ms, 1_000)).toBe(formatTimecode(ms).slice(0, -4));
    }
  });

  // ── The wall clock (V06-G3, D-092 ⑧) ─────────────────────────────────────────────────
  //
  // `vitest.config.ts` pins TZ to Europe/Oslo for the same reason `playwright.config.ts`
  // does: the ladder reads local wall time, so a CI box in UTC would make two different
  // answers indistinguishable. 06:00Z is 08:00 local — a hairdresser on a wedding morning.
  describe("with an origin epoch", () => {
    const origin = Date.parse("2026-08-15T06:00:00.000Z");

    it("prints the day's own clock instead of an elapsed count", () => {
      expect(tickLabel(0, 3_600_000, origin)).toBe("08:00");
      expect(tickLabel(2 * 3_600_000, 3_600_000, origin)).toBe("10:00");
      expect(tickLabel(90 * 60_000, 30 * 60_000, origin)).toBe("09:30");
    });

    it("adds seconds only when a minute cannot tell two ticks apart", () => {
      expect(tickLabel(65_000, 60_000, origin)).toBe("08:01");
      expect(tickLabel(65_000, 30_000, origin)).toBe("08:01:05");
      expect(tickLabel(1_500, 500, origin)).toBe("08:00:01");
    });

    it("wraps past midnight rather than counting past 24", () => {
      // The last dance is the next day, and it says so the way a clock does.
      expect(tickLabel(18 * 3_600_000, 3_600_000, origin)).toBe("02:00");
    });

    it("is the elapsed form again the moment the origin is unknown", () => {
      // After a sync, and before one when the ladder timed nothing: `null`, not a guess.
      expect(tickLabel(3_600_000, 3_600_000, null)).toBe("1:00:00");
      expect(tickLabel(3_600_000, 3_600_000)).toBe("1:00:00");
    });
  });
});
