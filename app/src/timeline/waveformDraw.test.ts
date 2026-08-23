import { describe, expect, it } from "vitest";
import { MIN_PX_PER_MS, type TimelineView } from "./geometry";
import {
  ANALYSIS_RATE_HZ,
  barAmplitudes,
  barGeometry,
  binDurationMs,
  MAX_BINS_PER_PX,
  pickLevel,
  type Level,
} from "./waveformDraw";

/** The real ladder shape: 13 levels, 120 samples doubling each step (peaks.rs). */
function ladder(levelCount = 13, totalSamples = 12_000 * 3600): { levels: Level[]; totalSamples: number } {
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
    // The zoom floor. A level ladder that ran out before here would be clamped to its
    // last entry rather than crashing — that fallback is what this pins.
    expect(pickLevel(levels.slice(0, 9), MIN_PX_PER_MS)).toBe(8);
  });

  it("the shipped ladder still lands within a bin or two of the zoom floor", () => {
    // Finding 11 was about ORDERS OF MAGNITUDE, and that is what this pins. With only 9
    // levels (the old 2.56 s bound) the coarsest bin was 0.05 px wide at the floor —
    // ~19.5 bins per pixel, i.e. a 4000-element `xs` array per clip per frame to paint a
    // couple of hundred pixels. `peaks.rs` runs the ladder to 40.96 s, and at the old
    // 2e-5 floor that cleared MAX_BINS_PER_PX outright (1.22 bins/px).
    //
    // D-084 halved the floor to 1e-5 so «Tilpass» can fit the owner's 15.5-hour wedding,
    // which halves every bin's on-screen width: the coarsest level now sits just OVER the
    // ceiling at 2.44 bins/px instead of just under it, so `barGeometry`'s stride cap —
    // which exists for exactly this — groups a couple of bins per bar. The claim that has
    // to survive is the size of the number, not which side of 2 it falls on: a handful of
    // bins per pixel, nowhere near twenty. The bounded `xs` itself is asserted below.
    const chosen = pickLevel(levels, MIN_PX_PER_MS);
    expect(chosen).toBe(levels.length - 1);
    const pxPerBin = binDurationMs(levels[chosen]) * MIN_PX_PER_MS;
    expect(1 / pxPerBin).toBeLessThan(4);
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

describe("barGeometry — anchored to real time, never stretched to the box", () => {
  // The clip box says 3600.000 s (ffprobe's container duration); the analysis cache
  // decoded 3599.200 s (AAC priming, an edit list, audio that ended before the video —
  // `probe.rs` and `extract.rs` measure different things and routinely disagree). The
  // drawn position of a bin must come from the fixed analysis rate alone.
  const CONTAINER_MS = 3_600_000;
  const DECODED_MS = 3_599_200;
  const meta = ladder(13, Math.round((ANALYSIS_RATE_HZ * DECODED_MS) / 1000));
  const span = { startMs: 0, endMs: CONTAINER_MS };

  it("bin k sits at span.startMs + k · binDurationMs, whatever totalSamples says", () => {
    const view: TimelineView = { pxPerMs: 0.001, scrollMs: 0, widthPx: 800 };
    const geom = barGeometry(span, meta, view, 1)!;
    expect(geom).not.toBeNull();
    expect(geom.stride).toBe(1);
    const binMs = binDurationMs(meta.levels[geom.level]);

    for (let i = 0; i < geom.xs.length; i += 37) {
      const k = geom.binStart + i;
      const expectedMsInClip = k * binMs;
      // xs is canvas-local device px; at dpr 1 and leftCssPx 0 that is clip-local CSS px.
      expect(geom.xs[i]).toBeCloseTo(expectedMsInClip * view.pxPerMs - geom.leftCssPx, 9);
    }
  });

  it("the same bin lands in the same place no matter how wrong totalSamples is", () => {
    const view: TimelineView = { pxPerMs: 0.001, scrollMs: 0, widthPx: 800 };
    const honest = barGeometry(span, meta, view, 1)!;
    // Half the samples, double the samples — neither may move a single bar.
    for (const factor of [0.5, 2, 1000]) {
      const skewed = {
        ...meta,
        totalSamples: Math.round(meta.totalSamples * factor),
      };
      const g = barGeometry(span, skewed, view, 1)!;
      expect(g.level).toBe(honest.level);
      expect(g.binStart).toBe(honest.binStart);
      expect(g.xs.length).toBe(honest.xs.length);
      for (let i = 0; i < honest.xs.length; i++) {
        expect(g.xs[i]).toBeCloseTo(honest.xs[i], 9);
      }
    }
  });

  it("an analysis shorter than the container leaves the tail unpainted, not stretched", () => {
    // Zoomed onto the clip's last two seconds. The decoded audio stops 800 ms before the
    // box does, so the last 800 ms of the box has no bins — and the bins that DO exist
    // must still be at their true times, not smeared out to reach the right edge.
    const view: TimelineView = {
      pxPerMs: 0.5,
      scrollMs: CONTAINER_MS - 2_000,
      widthPx: 1000,
    };
    const geom = barGeometry(span, meta, view, 1)!;
    expect(geom).not.toBeNull();
    const binMs = binDurationMs(meta.levels[geom.level]);
    const lastBin = geom.binStart + (geom.binCount - 1) * geom.stride;
    const lastBinEndMs = (lastBin + 1) * binMs;
    // Painting stops at the decoded end (within one bin), well short of the box.
    expect(lastBinEndMs).toBeLessThanOrEqual(DECODED_MS + binMs + 1e-6);
    expect(lastBinEndMs).toBeLessThan(CONTAINER_MS - 700);
    // ...and the last bar's x is its own true time, not the box's right edge.
    expect(geom.xs[geom.binCount - 1]).toBeCloseTo(
      lastBin * binMs * view.pxPerMs - geom.leftCssPx,
      6,
    );
  });
});

describe("barGeometry — DPR", () => {
  const totalSamples = ANALYSIS_RATE_HZ * 60; // a 1-minute clip
  const meta = ladder(13, totalSamples);
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

  it("bars never overlap at dpr 1, at every zoom the timeline allows", () => {
    // Finding 2: `barWidthPx` used to be floored at 1 device px while `xs` spacing was
    // not, so any level whose bins were under one device pixel wide had every bar
    // overpainting its neighbour — up to 100 % at dpr 1 (spacing 0.5, width 1.0). The old
    // fixture's single zoom never engaged the floor, so the assertion above passed
    // vacuously. This sweeps the whole zoom range at BOTH device pixel ratios.
    const oneHour = ladder(13, ANALYSIS_RATE_HZ * 3600);
    const hourSpan = { startMs: 0, endMs: 3_600_000 };
    for (const dpr of [1, 2]) {
      for (const pxPerMs of [
        MIN_PX_PER_MS, 0.00005, 0.000125, 0.0005, 0.00125, 0.0125, 0.05, 0.2, 0.75, 2,
      ]) {
        const g = barGeometry(hourSpan, oneHour, { pxPerMs, scrollMs: 0, widthPx: 900 }, dpr);
        if (!g) continue;
        const label = `dpr ${dpr}, pxPerMs ${pxPerMs}`;
        expect(g.barWidthPx, label).toBeGreaterThan(0);
        for (let i = 1; i < g.xs.length; i++) {
          expect(g.xs[i] - g.xs[i - 1], label).toBeCloseTo(g.barWidthPx, 6);
        }
      }
    }
  });

  it("level selection is device-pixel-relative, so dpr 2 may pick a finer level", () => {
    // The mechanism behind the fix: MAX_BINS_PER_PX is a claim about DEVICE pixels, and a
    // retina panel really can resolve twice the detail at the same zoom.
    const oneHour = ladder(13, ANALYSIS_RATE_HZ * 3600);
    const hourSpan = { startMs: 0, endMs: 3_600_000 };
    const v: TimelineView = { pxPerMs: 0.0125, scrollMs: 0, widthPx: 900 };
    const g1 = barGeometry(hourSpan, oneHour, v, 1)!;
    const g2 = barGeometry(hourSpan, oneHour, v, 2)!;
    expect(g2.level).toBe(g1.level - 1);
    // And the chosen level's bins are at least half a device pixel wide in both cases —
    // the guarantee that makes the defensive width floor unreachable.
    for (const [g, dpr] of [
      [g1, 1],
      [g2, 2],
    ] as const) {
      const binDevicePx = binDurationMs(oneHour.levels[g.level]) * v.pxPerMs * dpr;
      expect(binDevicePx).toBeGreaterThanOrEqual(1 / MAX_BINS_PER_PX - 1e-9);
    }
  });
});

describe("barGeometry — the strided fallback bounds xs (finding 11)", () => {
  it("a 3-hour clip at its fit zoom emits at most ~2 bars per device pixel", () => {
    const threeHoursMs = 3 * 3_600_000;
    const meta = ladder(13, ANALYSIS_RATE_HZ * 3 * 3600);
    const span = { startMs: 0, endMs: threeHoursMs };
    const widthPx = 1200;
    // Fit: the whole thing across the window (viewport.ts `fitPxPerMs`, padding ignored).
    const view: TimelineView = { pxPerMs: widthPx / threeHoursMs, scrollMs: 0, widthPx };

    for (const dpr of [1, 2]) {
      const g = barGeometry(span, meta, view, dpr)!;
      expect(g).not.toBeNull();
      // Concrete ceiling: 2 bars per device pixel of the DRAWN width, plus one for the
      // partial bar at each edge. At dpr 1 that is 2402, not the 4219 the 9-level ladder
      // produced; at dpr 2, 4802.
      const ceiling = MAX_BINS_PER_PX * g.widthCssPx * dpr + 2;
      expect(g.xs.length).toBeLessThanOrEqual(ceiling);
      expect(g.xs.length).toBe(g.binCount);
    }
  });

  it("at the D-084 zoom floor, the coarsest level strides 2-3 bins into one bar", () => {
    // The new floor's own case (D-084). A 90-minute clip — long enough that D-072's
    // `MIN_WAVEFORM_PX` would still let it draw a waveform at this zoom, which is the only
    // reason any of this arithmetic runs at the floor at all — over the shipped 13-level
    // ladder, at exactly `MIN_PX_PER_MS`.
    //
    // At 1e-5 the coarsest level's 40.96 s bins are 0.4096 CSS px wide, so the display can
    // use rather fewer of them than the level offers: 2.44 bins per device pixel at dpr 1,
    // 1.22 at dpr 2. The stride cap turns that into one bar per 2 bins (dpr 1) — and no
    // stride at all on a retina panel, which really can resolve the extra detail.
    const ninetyMinMs = 90 * 60_000;
    const meta = ladder(13, ANALYSIS_RATE_HZ * 90 * 60);
    const span = { startMs: 0, endMs: ninetyMinMs };
    const view: TimelineView = { pxPerMs: MIN_PX_PER_MS, scrollMs: 0, widthPx: 736 };

    const g1 = barGeometry(span, meta, view, 1)!;
    expect(g1).not.toBeNull();
    expect(g1.level).toBe(12); // the coarsest rung, 40.96 s bins
    expect(g1.stride).toBe(2);
    const g2 = barGeometry(span, meta, view, 2)!;
    expect(g2.stride).toBe(1);

    // Whatever the stride, the bound is the same one finding 11 bought: a couple of bars
    // per device pixel of drawn width, never one per bin.
    for (const [g, dpr] of [
      [g1, 1],
      [g2, 2],
    ] as const) {
      expect(g.xs.length).toBeLessThanOrEqual(MAX_BINS_PER_PX * g.widthCssPx * dpr + 2);
      expect(g.xs.length).toBe(g.binCount);
      // Strided bars stay abutting — the property a naive `stride` breaks first.
      for (let i = 1; i < g.xs.length; i++) {
        expect(g.xs[i] - g.xs[i - 1], `dpr ${dpr}`).toBeCloseTo(g.barWidthPx, 6);
      }
    }
  });

  it("clamps xs even against a pathologically short ladder", () => {
    // Belt and braces: if `peaks.rs` ever stopped its ladder early again, the renderer
    // strides rather than emitting one entry per bin.
    const threeHoursMs = 3 * 3_600_000;
    const stunted = ladder(3, ANALYSIS_RATE_HZ * 3 * 3600); // coarsest bin: 40 ms
    const span = { startMs: 0, endMs: threeHoursMs };
    const widthPx = 1200;
    const view: TimelineView = { pxPerMs: widthPx / threeHoursMs, scrollMs: 0, widthPx };

    const g = barGeometry(span, stunted, view, 1)!;
    expect(g.stride).toBeGreaterThan(1);
    expect(g.xs.length).toBeLessThanOrEqual(MAX_BINS_PER_PX * g.widthCssPx + 2);
    // Strided bars are still abutting and still anchored to real time.
    const binMs = binDurationMs(stunted.levels[g.level]);
    for (let i = 1; i < g.xs.length; i++) {
      expect(g.xs[i] - g.xs[i - 1]).toBeCloseTo(g.barWidthPx, 6);
    }
    expect(g.xs[0]).toBeCloseTo(g.binStart * binMs * view.pxPerMs - g.leftCssPx, 6);
  });
});

describe("barAmplitudes — a buffer shorter than meta promised (finding 3)", () => {
  const meta = ladder(13, ANALYSIS_RATE_HZ * 60);
  const span = { startMs: 0, endMs: 60_000 };
  const view: TimelineView = { pxPerMs: 0.05, scrollMs: 0, widthPx: 800 };

  it("never yields NaN when the level buffer is short", () => {
    // `metaCache` and `levelCache` are filled by two independent `invoke`s; the pyramid
    // on disk can be rebuilt between them (mtime change, sweep, regenerate). The old
    // draw loop indexed straight past the end, got `undefined / 255` = NaN, and sailed
    // through `if (h <= 0) continue` because every NaN comparison is false.
    const geom = barGeometry(span, meta, view, 1)!;
    expect(geom.binCount).toBeGreaterThan(10);

    const short = new Uint8Array(6); // three bins' worth, for hundreds of bars
    const { peak, rms } = barAmplitudes(geom, short);
    expect(peak.length).toBe(geom.binCount);
    expect(rms.length).toBe(geom.binCount);
    for (let i = 0; i < geom.binCount; i++) {
      expect(Number.isFinite(peak[i]), `peak[${i}]`).toBe(true);
      expect(Number.isFinite(rms[i]), `rms[${i}]`).toBe(true);
    }
    // An empty buffer is the same story, not a crash.
    const none = barAmplitudes(geom, new Uint8Array(0));
    expect(Array.from(none.peak).every((v) => v === 0)).toBe(true);
  });

  it("reads the bins it does have, in the right place", () => {
    const geom = barGeometry(span, meta, view, 1)!;
    const bytes = new Uint8Array((geom.binStart + geom.binCount) * 2);
    bytes[geom.binStart * 2] = 255;
    bytes[geom.binStart * 2 + 1] = 51;
    const { peak, rms } = barAmplitudes(geom, bytes);
    expect(peak[0]).toBeCloseTo(1, 6);
    expect(rms[0]).toBeCloseTo(0.2, 6);
    expect(peak[1]).toBe(0);
  });

  it("a strided bar takes the loudest bin of its group", () => {
    const threeHoursMs = 3 * 3_600_000;
    const stunted = ladder(3, ANALYSIS_RATE_HZ * 3 * 3600);
    const widthPx = 1200;
    const g = barGeometry(
      { startMs: 0, endMs: threeHoursMs },
      stunted,
      { pxPerMs: widthPx / threeHoursMs, scrollMs: 0, widthPx },
      1,
    )!;
    expect(g.stride).toBeGreaterThan(1);

    const bytes = new Uint8Array(stunted.levels[g.level].bins * 2);
    // One loud bin, buried in the middle of the very first bar's group.
    const loud = g.binStart + (g.stride >> 1);
    bytes[loud * 2] = 200;
    bytes[loud * 2 + 1] = 100;
    const { peak, rms } = barAmplitudes(g, bytes);
    expect(peak[0]).toBeCloseTo(200 / 255, 6);
    expect(rms[0]).toBeCloseTo(100 / 255, 6);
    expect(peak[1]).toBe(0);
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
