import { describe, expect, it } from "vitest";
import type { TimelineView } from "./geometry";
import { ANALYSIS_RATE_HZ, barGeometry, binDurationMs, pickLevel, type Level } from "./waveformDraw";

/** The real ladder shape: 9 levels, 120 samples doubling each step (peaks.rs). */
function ladder(levelCount = 9, totalSamples = 12_000 * 3600): { levels: Level[]; totalSamples: number } {
  const levels: Level[] = [];
  let binSamples = 120;
  for (let i = 0; i < levelCount; i++) {
    levels.push({ binSamples, bins: Math.ceil(totalSamples / binSamples) });
    binSamples *= 2;
  }
  return { levels, totalSamples };
}

describe("binDurationMs", () => {
  it("level 0 is 10ms at the fixed analysis rate", () => {
    expect(binDurationMs({ binSamples: 120, bins: 1 })).toBeCloseTo(10);
  });

  it("doubles with the bin size, as the pyramid's levels do", () => {
    expect(binDurationMs({ binSamples: 240, bins: 1 })).toBeCloseTo(20);
    expect(binDurationMs({ binSamples: 120 * 256, bins: 1 })).toBeCloseTo(2560); // level 8
  });

  it("is consistent with the documented analysis rate constant", () => {
    expect(ANALYSIS_RATE_HZ).toBe(12_000);
  });
});

describe("pickLevel — zoom extremes", () => {
  const { levels } = ladder();

  it("returns the finest level (0) at the tightest zoom", () => {
    // 2 px/ms (MAX_PX_PER_MS): even level 0's 10ms bins are 20px wide — comfortably
    // under the 2 bins/px ceiling.
    expect(pickLevel(levels, 2)).toBe(0);
  });

  it("returns the coarsest level at the widest zoom-out", () => {
    // 0.00002 px/ms (MIN_PX_PER_MS): even the coarsest 2.56s bin is a fraction of a
    // pixel wide, so every level is still over the 2 bins/px ceiling — the best
    // available is the last one, not a crash.
    expect(pickLevel(levels, 0.00002)).toBe(levels.length - 1);
  });

  it("picks a level in between at a middling zoom, never finer than the ceiling allows", () => {
    // Pick a pxPerMs where level 3 (80ms bins) sits right at 2 bins/px: pxPerBin = 0.5
    // means bins/px = 2. Slightly under is still level 3; the chosen level itself must
    // never exceed the ceiling.
    const lvl3 = levels[3]; // 960 samples = 80ms
    const pxPerMs = 0.5 / binDurationMs(lvl3);
    const chosen = pickLevel(levels, pxPerMs);
    const pxPerBinChosen = binDurationMs(levels[chosen]) * pxPerMs;
    expect(1 / pxPerBinChosen).toBeLessThanOrEqual(2 + 1e-9);
    // ...and the next-finer level (if any) would have busted the ceiling — otherwise
    // pickLevel should have chosen it instead (it scans finest-first).
    if (chosen > 0) {
      const pxPerBinFiner = binDurationMs(levels[chosen - 1]) * pxPerMs;
      expect(1 / pxPerBinFiner).toBeGreaterThan(2);
    }
  });

  it("monotonic: zooming in never coarsens the chosen level", () => {
    let prev = pickLevel(levels, 0.0001);
    for (const pxPerMs of [0.001, 0.01, 0.1, 1, 2]) {
      const cur = pickLevel(levels, pxPerMs);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });

  it("empty ladder yields -1", () => {
    expect(pickLevel([], 1)).toBe(-1);
  });
});

describe("barGeometry — intersection clipping", () => {
  const totalSamples = ANALYSIS_RATE_HZ * 3600; // a 1-hour clip
  const meta = ladder(9, totalSamples);
  const durationMs = 3600 * 1000;

  it("clips the left edge: a clip scrolled mostly off-screen left only draws its visible tail", () => {
    const span = { startMs: 0, endMs: durationMs };
    // Zoomed so the whole clip is 3600px wide, scrolled 3000ms in, viewport 800px.
    const view: TimelineView = { pxPerMs: 1, scrollMs: 3000, widthPx: 800 };
    const geom = barGeometry(span, meta, view, 1);
    expect(geom).not.toBeNull();
    // `leftCssPx` is clip-LOCAL (0 = the clip's own left edge, not the viewport's): the
    // clip's own left edge is 3000px off-screen, so the visible slice starts 3000px into
    // the clip's own box.
    expect(geom!.leftCssPx).toBeCloseTo(3000);
    expect(geom!.widthCssPx).toBeCloseTo(800);
  });

  it("clips the right edge: a clip extending past the viewport only draws up to it", () => {
    const span = { startMs: 0, endMs: durationMs };
    const view: TimelineView = { pxPerMs: 0.01, scrollMs: 0, widthPx: 200 };
    // Clip is 36000ms * 0.01 = 360px wide — wider than the 200px viewport.
    const geom = barGeometry(span, meta, view, 1);
    expect(geom).not.toBeNull();
    expect(geom!.leftCssPx).toBeCloseTo(0);
    expect(geom!.widthCssPx).toBeCloseTo(200);
  });

  it("clips both edges: a clip wider than the viewport on both sides", () => {
    const span = { startMs: 0, endMs: durationMs };
    const view: TimelineView = { pxPerMs: 1, scrollMs: 1000, widthPx: 500 };
    const geom = barGeometry(span, meta, view, 1);
    expect(geom).not.toBeNull();
    // Clip-local: the clip's own left edge is 1000px off-screen to the left.
    expect(geom!.leftCssPx).toBeCloseTo(1000);
    expect(geom!.widthCssPx).toBeCloseTo(500);
    // Every bar must land within the drawn canvas width (device px === css px at dpr 1).
    for (const x of geom!.xs) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(500 + geom!.barWidthPx + 1e-6);
    }
  });

  it("a clip fully outside the viewport yields null", () => {
    const span = { startMs: 0, endMs: durationMs };
    const view: TimelineView = { pxPerMs: 1, scrollMs: durationMs + 10_000, widthPx: 800 };
    expect(barGeometry(span, meta, view, 1)).toBeNull();
  });

  it("a clip fully inside the viewport is not clipped at all", () => {
    const span = { startMs: 10_000, endMs: 20_000 };
    const view: TimelineView = { pxPerMs: 0.05, scrollMs: 0, widthPx: 2000 };
    const geom = barGeometry(span, meta, view, 1);
    expect(geom).not.toBeNull();
    expect(geom!.leftCssPx).toBeCloseTo(0);
    expect(geom!.widthCssPx).toBeCloseTo((20_000 - 10_000) * 0.05);
  });
});

describe("barGeometry — DPR", () => {
  const totalSamples = ANALYSIS_RATE_HZ * 60; // a 1-minute clip
  const meta = ladder(9, totalSamples);
  const span = { startMs: 0, endMs: 60_000 };
  const view: TimelineView = { pxPerMs: 0.5, scrollMs: 0, widthPx: 400 };

  it("device-px fields double from dpr 1 to dpr 2; CSS-px fields do not", () => {
    const g1 = barGeometry(span, meta, view, 1);
    const g2 = barGeometry(span, meta, view, 2);
    expect(g1).not.toBeNull();
    expect(g2).not.toBeNull();

    expect(g1!.leftCssPx).toBeCloseTo(g2!.leftCssPx);
    expect(g1!.widthCssPx).toBeCloseTo(g2!.widthCssPx);
    expect(g1!.level).toBe(g2!.level);
    expect(g1!.binCount).toBe(g2!.binCount);

    expect(g2!.barWidthPx).toBeCloseTo(g1!.barWidthPx * 2);
    for (let i = 0; i < g1!.xs.length; i++) {
      expect(g2!.xs[i]).toBeCloseTo(g1!.xs[i] * 2, 3);
    }
  });

  it("bars stay abutting (no gaps, no overlap) at both DPRs", () => {
    for (const dpr of [1, 2]) {
      const g = barGeometry(span, meta, view, dpr)!;
      for (let i = 1; i < g.xs.length; i++) {
        expect(g.xs[i] - g.xs[i - 1]).toBeCloseTo(g.barWidthPx, 3);
      }
    }
  });
});

describe("barGeometry — empty / degenerate inputs", () => {
  const view: TimelineView = { pxPerMs: 0.1, scrollMs: 0, widthPx: 800 };

  it("an empty ladder yields null", () => {
    const span = { startMs: 0, endMs: 1000 };
    expect(barGeometry(span, { totalSamples: 12_000, levels: [] }, view, 1)).toBeNull();
  });

  it("zero total samples yields null (nothing decoded yet)", () => {
    const span = { startMs: 0, endMs: 1000 };
    const meta = { totalSamples: 0, levels: [{ binSamples: 120, bins: 0 }] };
    expect(barGeometry(span, meta, view, 1)).toBeNull();
  });

  it("a zero-length span yields null", () => {
    const span = { startMs: 500, endMs: 500 };
    const meta = ladder(9, 12_000 * 10);
    expect(barGeometry(span, meta, view, 1)).toBeNull();
  });

  it("a level with no bins yields null even if the ladder itself is non-empty", () => {
    const span = { startMs: 0, endMs: 1000 };
    const meta = { totalSamples: 12_000, levels: [{ binSamples: 120, bins: 0 }] };
    expect(barGeometry(span, meta, view, 1)).toBeNull();
  });
});
