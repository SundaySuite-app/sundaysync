import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RATE,
  CHUNK_SAMPLES,
  catchUp,
  chunkCount,
  chunkTimelineSpan,
  clipTransport,
  computeSchedule,
  timelineDurationSec,
  type PlacedClip,
  type ResidentLookup,
  type ScheduleOptions,
} from "./schedulePlan";

const CHUNK_SEC = CHUNK_SAMPLES / ANALYSIS_RATE; // 15

/** Everything is resident — the default for tests about arithmetic rather than buffering. */
const ALL: ResidentLookup = { has: () => true };

function only(pairs: [string, number][]): ResidentLookup {
  const set = new Set(pairs.map(([f, k]) => `${f}#${k}`));
  return { has: (f, k) => set.has(`${f}#${k}`) };
}

function clip(over: Partial<PlacedClip> = {}): PlacedClip {
  return {
    file: "/a.wav",
    device: "rec",
    startSec: 0,
    durationSec: 60,
    driftPpm: null,
    projectedEndErrorMs: null,
    ...over,
  };
}

const OPTS: ScheduleOptions = { driftCorrected: true, horizonAheadSec: 30 };

describe("clipTransport — drift", () => {
  it("leaves a clip alone when the engine measured no drift", () => {
    const t = clipTransport(clip(), OPTS);
    expect(t.rate).toBe(1);
    expect(t.corrected).toBe(false);
    expect(t.startSec).toBe(0);
    expect(t.endSec).toBeCloseTo(60, 9);
  });

  it("leaves every clip alone when the toggle is off", () => {
    const c = clip({ durationSec: 1000, driftPpm: 500, projectedEndErrorMs: 500 });
    const t = clipTransport(c, { driftCorrected: false });
    expect(t.rate).toBe(1);
    expect(t.corrected).toBe(false);
    expect(t.startSec).toBe(c.startSec);
  });

  // ---- The sign trap (D-019/D-042), pinned ----------------------------------------
  //
  // Mirrors `crates/core/src/drift.rs`'s
  // `correction_cancels_the_end_error_and_inversion_doubles_it`, using the same ground
  // truth: `ppm` is `d(offset)/d(position)`, so a source position `p` belongs at reference
  // time `offset_0 + (1 + ppm·1e-6)·p`. Nothing here leans on the ambiguous "stretched by
  // N ppm" framing — which is exactly how this sign gets inverted.
  it("moves a corrected clip's end in the direction that CANCELS the drift", () => {
    const l = 1000; // source seconds — the brief's 1000 s clip
    const offset0 = 3; // timeline time of the clip's first sample, reference-correct

    for (const ppm of [500, -500, 40, -40, -58.69, 24.75]) {
      const slope = ppm * 1e-6;
      const projectedEndErrorMs = slope * l * 1000;
      // §4.3 places on the MEDIAN, i.e. the offset measured at the clip's midpoint —
      // which is what §5 carries and what the timeline draws.
      const medianOffset = offset0 + (slope * l) / 2;

      const t = clipTransport(
        clip({
          startSec: medianOffset,
          durationSec: l,
          driftPpm: ppm,
          projectedEndErrorMs,
        }),
        OPTS,
      );

      const idealEnd = offset0 + (1 + slope) * l;
      const fullDrift = Math.abs(slope * l);

      expect(t.corrected).toBe(true);
      // The end lands where the reference puts it.
      expect(Math.abs(t.endSec - idealEnd)).toBeLessThan(1e-6);
      // …and so does the start, which is the half-drift the median placement owes.
      expect(Math.abs(t.startSec - offset0)).toBeLessThan(1e-9);

      // Uncorrected (1:1 from the same start) is one full drift out.
      const uncorrectedEnd = t.startSec + l;
      expect(Math.abs(Math.abs(uncorrectedEnd - idealEnd) - fullDrift)).toBeLessThan(1e-6);

      // The inverted rate — `1 + ppm·1e-6` instead of its reciprocal — is the bug D-019
      // warns about: it moves the end the WRONG WAY, to roughly twice the drift out.
      const invertedRate = 1 + slope;
      const invertedEnd = t.startSec + l / invertedRate;
      expect(Math.abs(invertedEnd - idealEnd)).toBeGreaterThan(1.8 * fullDrift);

      // …and not only the endpoint: the WHOLE mapping matches `fcpxml.rs`'s `<timeMap>`
      // semantics, `timeline_time = offset₀ + (1 + k)·p` for every source position p.
      // Chunk boundaries are where the scheduler actually reads this off, so they are
      // what gets checked.
      for (let k = 0; k < chunkCount(t.sourceSamples); k += 1) {
        const p = (k * CHUNK_SAMPLES) / ANALYSIS_RATE;
        expect(chunkTimelineSpan(t, k).startSec).toBeCloseTo(offset0 + (1 + slope) * p, 6);
      }
    }
  });

  it("uses the exact reciprocal, not the linearisation", () => {
    const t = clipTransport(
      clip({ durationSec: 1000, driftPpm: 500, projectedEndErrorMs: 500 }),
      OPTS,
    );
    expect(t.rate).toBeCloseTo(1 / 1.0005, 15);
    expect(t.rate).not.toBe(1 - 500e-6);
  });

  it("refuses a drift no clock could produce (D-045)", () => {
    // E10's edited-mix corpus reported −587 484 ppm. Applied as a playback rate that is
    // a 2.4× speed-up, and the operator would blame the sync, not the measurement.
    const t = clipTransport(
      clip({ durationSec: 1000, driftPpm: -587_484, projectedEndErrorMs: -587_484 }),
      OPTS,
    );
    expect(t.rate).toBe(1);
    expect(t.corrected).toBe(false);
  });

  it("mirrors the exporter's half-frame gate when an fps is supplied", () => {
    // 25 fps → half a frame is 20 ms. A 10 ms end error is left exactly as the export
    // leaves it; a 30 ms one is corrected.
    const small = clipTransport(
      clip({ durationSec: 1000, driftPpm: 10, projectedEndErrorMs: 10 }),
      { driftCorrected: true, fps: 25 },
    );
    expect(small.corrected).toBe(false);

    const big = clipTransport(clip({ durationSec: 1000, driftPpm: 30, projectedEndErrorMs: 30 }), {
      driftCorrected: true,
      fps: 25,
    });
    expect(big.corrected).toBe(true);
  });
});

describe("computeSchedule", () => {
  it("keeps two clips' relative timing exactly equal to their offset delta", () => {
    // The single most important assertion in the file: if this is off by a millisecond,
    // the operator hears an echo and blames the engine.
    const a = clip({ file: "/a.wav", device: "rec", startSec: 0, durationSec: 120 });
    const b = clip({ file: "/b.mp4", device: "cam", startSec: 4.2, durationSec: 120 });

    const s = computeSchedule([a, b], 0, ALL, OPTS);
    const first = (file: string) => s.find((e) => e.file === file && e.chunkIndex === 0)!;

    expect(first("/b.mp4").whenOffsetSec - first("/a.wav").whenOffsetSec).toBeCloseTo(4.2, 12);
  });

  it("holds that delta at chunk 40 of a long clip, with no accumulated float drift", () => {
    // Deriving each chunk from its index rather than from its predecessor is what this
    // asserts: chunk 40 is 600 s in, and 40 roundings of 15 s would be visible here.
    const a = clip({ file: "/a.wav", startSec: 0, durationSec: 3600 });
    const b = clip({ file: "/b.mp4", startSec: 4.2, durationSec: 3600 });

    const s = computeSchedule([a, b], 600, ALL, { ...OPTS, horizonAheadSec: 60 });
    const at = (file: string, k: number) =>
      s.find((e) => e.file === file && e.chunkIndex === k)!;

    // /a.wav's chunk 40 starts exactly at t=600, /b.mp4's at 4.2 s later in the clip's
    // own frame — so the two chunk-41 starts stay 4.2 s apart to the last bit.
    const da = at("/a.wav", 41).whenOffsetSec;
    const db = at("/b.mp4", 41).whenOffsetSec;
    expect(db - da).toBeCloseTo(4.2, 12);
  });

  it("enters a clip mid-chunk with the sample-exact offset", () => {
    const c = clip({ startSec: 10, durationSec: 600 });
    // 100 s into the timeline is 90 s into the clip: chunk 6 (90–105 s), 0 s in.
    const at90 = computeSchedule([c], 100, ALL, OPTS);
    expect(at90[0].chunkIndex).toBe(6);
    expect(at90[0].whenOffsetSec).toBe(0);
    expect(at90[0].sourceOffsetSec).toBeCloseTo(0, 12);

    // 103.5 s is 93.5 s into the clip: still chunk 6, 3.5 s into its buffer.
    const at935 = computeSchedule([c], 103.5, ALL, OPTS);
    expect(at935[0].chunkIndex).toBe(6);
    expect(at935[0].whenOffsetSec).toBe(0);
    expect(at935[0].sourceOffsetSec).toBeCloseTo(3.5, 12);
    expect(at935[0].sourceDurationSec).toBeCloseTo(CHUNK_SEC - 3.5, 12);
  });

  it("leaves no gap and no overlap between consecutive chunks", () => {
    // A seam that is 1 ms short is a click; 1 ms long is a stutter. Both are the failure
    // mode a listener notices and no length assertion catches.
    const c = clip({ startSec: 2.5, durationSec: 100, driftPpm: 300, projectedEndErrorMs: 30 });
    const t = clipTransport(c, OPTS);
    const s = computeSchedule([c], 0, ALL, { ...OPTS, horizonAheadSec: 1000 });

    expect(s).toHaveLength(chunkCount(t.sourceSamples));
    for (let i = 0; i < s.length; i += 1) {
      const span = chunkTimelineSpan(t, s[i].chunkIndex);
      // Where this source will actually sound, on the timeline.
      const soundsAt = s[i].whenOffsetSec + 0; // t=0, so whenOffset IS timeline time
      expect(soundsAt).toBeCloseTo(span.startSec, 9);
      if (i > 0) {
        const prev = s[i - 1];
        const prevEnd = prev.whenOffsetSec + prev.sourceDurationSec / prev.rate;
        expect(soundsAt).toBeCloseTo(prevEnd, 9);
      }
    }
    // The last chunk ends exactly where the transport says the clip does.
    const last = s[s.length - 1];
    expect(last.whenOffsetSec + last.sourceDurationSec / last.rate).toBeCloseTo(t.endSec, 9);
  });

  it("stops at the horizon and never schedules the past", () => {
    const c = clip({ startSec: 0, durationSec: 3600 });
    const s = computeSchedule([c], 100, ALL, { ...OPTS, horizonAheadSec: 30 });

    // 100 s in: the standing chunk is 6 (90–105), then 7 and 8 fit inside +30 s.
    expect(s.map((e) => e.chunkIndex)).toEqual([6, 7, 8]);
    for (const e of s) expect(e.whenOffsetSec).toBeGreaterThanOrEqual(0);
  });

  it("skips a clip that has already ended and one that starts past the horizon", () => {
    const done = clip({ file: "/done.wav", startSec: 0, durationSec: 50 });
    const later = clip({ file: "/later.wav", startSec: 500, durationSec: 50 });
    const now = clip({ file: "/now.wav", startSec: 90, durationSec: 50 });

    const s = computeSchedule([done, later, now], 100, ALL, OPTS);
    expect(new Set(s.map((e) => e.file))).toEqual(new Set(["/now.wav"]));
  });

  it("returns only chunks that are resident", () => {
    const c = clip({ startSec: 0, durationSec: 3600 });
    const s = computeSchedule([c], 100, only([["/a.wav", 8]]), OPTS);
    expect(s.map((e) => e.chunkIndex)).toEqual([8]);
  });

  it("gives every source rate 1 when drift correction is off", () => {
    const clips = [
      clip({ file: "/a.wav", durationSec: 600, driftPpm: 300, projectedEndErrorMs: 180 }),
      clip({ file: "/b.wav", durationSec: 600, driftPpm: -120, projectedEndErrorMs: -72 }),
    ];
    const s = computeSchedule(clips, 0, ALL, { driftCorrected: false, horizonAheadSec: 30 });
    expect(s.length).toBeGreaterThan(0);
    for (const e of s) expect(e.rate).toBe(1);
  });

  it("carries the corrected rate onto every one of a drifting clip's sources", () => {
    const c = clip({ durationSec: 600, driftPpm: 200, projectedEndErrorMs: 120 });
    const s = computeSchedule([c], 0, ALL, OPTS);
    for (const e of s) expect(e.rate).toBeCloseTo(1 / 1.0002, 15);
  });

  it("ignores a zero-length clip instead of scheduling an empty source", () => {
    expect(computeSchedule([clip({ durationSec: 0 })], 0, ALL, OPTS)).toEqual([]);
  });
});

describe("catchUp", () => {
  const entry = {
    file: "/a.wav",
    device: "rec",
    chunkIndex: 3,
    whenOffsetSec: 2,
    sourceOffsetSec: 0,
    sourceDurationSec: 15,
    rate: 1,
  };

  it("is a no-op when the chunk is on time", () => {
    expect(catchUp(entry, 0)).toBe(entry);
    expect(catchUp(entry, -1)).toBe(entry);
  });

  it("skips exactly the elapsed part rather than playing it late", () => {
    const late = catchUp(entry, 0.4)!;
    expect(late.whenOffsetSec).toBeCloseTo(2.4, 12);
    expect(late.sourceOffsetSec).toBeCloseTo(0.4, 12);
    expect(late.sourceDurationSec).toBeCloseTo(14.6, 12);
    // The chunk still ends where it always would have: no echo, no stretch.
    expect(late.whenOffsetSec + late.sourceDurationSec / late.rate).toBeCloseTo(
      entry.whenOffsetSec + entry.sourceDurationSec / entry.rate,
      12,
    );
  });

  it("accounts for the playback rate when skipping", () => {
    const drifting = { ...entry, rate: 0.5 };
    const late = catchUp(drifting, 1)!;
    expect(late.sourceOffsetSec).toBeCloseTo(0.5, 12);
  });

  it("drops a chunk that arrived after it was wholly over", () => {
    expect(catchUp(entry, 20)).toBeNull();
  });
});

describe("timelineDurationSec", () => {
  it("is the last clip's end, drift included", () => {
    const clips = [
      clip({ file: "/a.wav", startSec: 0, durationSec: 100 }),
      clip({ file: "/b.wav", startSec: 50, durationSec: 100 }),
    ];
    expect(timelineDurationSec(clips, OPTS)).toBeCloseTo(150, 9);
    expect(timelineDurationSec([], OPTS)).toBe(0);
  });
});
