import { describe, expect, it } from "vitest";
import {
  AHEAD_SEC,
  BEHIND_SEC,
  BUDGET_BYTES,
  CHUNK_BYTES,
  chooseEvictions,
  chunkCapacity,
  chunkKey,
  distanceToSpan,
  planChunks,
  type PlanOptions,
  type ResidentChunk,
} from "./pcmPlan";
import { CHUNK_SAMPLES, ANALYSIS_RATE, type PlacedClip } from "./schedulePlan";

const CHUNK_SEC = CHUNK_SAMPLES / ANALYSIS_RATE; // 15

function clip(over: Partial<PlacedClip> = {}): PlacedClip {
  return {
    file: "/a.wav",
    device: "rec",
    startSec: 0,
    durationSec: 3600,
    driftPpm: null,
    projectedEndErrorMs: null,
    ...over,
  };
}

const OPTS: PlanOptions = { driftCorrected: true };

describe("the budget", () => {
  it("is 256 MB of 720 KB chunks", () => {
    expect(CHUNK_BYTES).toBe(720_000);
    expect(BUDGET_BYTES).toBe(268_435_456);
    expect(chunkCapacity()).toBe(372);
    // ~93 minutes of one clip, which is a whole service — the cap only bites on
    // many-camera shoots, which is exactly where it is needed.
    expect((chunkCapacity() * CHUNK_SEC) / 60).toBeGreaterThan(90);
  });
});

describe("planChunks", () => {
  it("covers the window behind and ahead of the playhead", () => {
    // At t=600 the window is [585, 630): chunks 39 (585–600), 40, 41 — 41 ends at 630,
    // and a chunk whose span merely touches the edge is not needed.
    const got = planChunks([clip()], 600, OPTS).map((r) => r.chunkIndex);
    expect(new Set(got)).toEqual(new Set([39, 40, 41]));
  });

  it("uses the documented default horizon", () => {
    expect(AHEAD_SEC).toBe(30);
    expect(BEHIND_SEC).toBe(15);
    const wide = planChunks([clip()], 600, { ...OPTS, aheadSec: 60, behindSec: 60 });
    expect(wide.length).toBeGreaterThan(planChunks([clip()], 600, OPTS).length);
  });

  it("orders nearest to the playhead first — that is the fetch priority", () => {
    const got = planChunks([clip()], 600.1, OPTS);
    // t sits inside chunk 40 (600–615), so distance 0; then 41 (0.1 ahead is nearest edge
    // 614.9… no — 41 starts at 615, so 14.9), then 39 (ends at 600, so 0.1).
    expect(got[0].chunkIndex).toBe(40);
    expect(got[1].chunkIndex).toBe(39);
    expect(got[2].chunkIndex).toBe(41);
  });

  it("interleaves clips by distance rather than finishing one clip first", () => {
    const clips = [
      clip({ file: "/a.wav", startSec: 0, durationSec: 3600 }),
      clip({ file: "/b.mp4", startSec: 0, durationSec: 3600 }),
    ];
    const got = planChunks(clips, 600.1, OPTS);
    // Both clips' standing chunks (distance 0) come before either clip's look-ahead.
    expect(new Set(got.slice(0, 2).map((r) => r.file))).toEqual(new Set(["/a.wav", "/b.mp4"]));
    expect(got.slice(0, 2).every((r) => r.chunkIndex === 40)).toBe(true);
  });

  it("plans nothing for a clip outside the window", () => {
    const clips = [
      clip({ file: "/past.wav", startSec: 0, durationSec: 100 }),
      clip({ file: "/future.wav", startSec: 5000, durationSec: 100 }),
    ];
    expect(planChunks(clips, 600, OPTS)).toEqual([]);
  });

  it("follows the drift-corrected timeline when correction is on", () => {
    // Correction moves this clip's start to +0.9 s and stretches every chunk by 500 ppm,
    // so the plan has to look where the audio will actually be, not where §5 stored it.
    // At t=0.5 s the window ends at 30.5 s: uncorrected, chunk 2 starts at 30.0 and is
    // needed; corrected, it starts at 30.885 and is not.
    const drifting = clip({ durationSec: 3600, driftPpm: -500, projectedEndErrorMs: -1800 });
    const on = planChunks([drifting], 0.5, { driftCorrected: true }).map((r) => r.chunkIndex);
    const off = planChunks([drifting], 0.5, { driftCorrected: false }).map((r) => r.chunkIndex);
    expect(new Set(on)).toEqual(new Set([0, 1]));
    expect(new Set(off)).toEqual(new Set([0, 1, 2]));
  });

  it("never plans more than the budget can hold", () => {
    // 400 clips all standing at the playhead: the plan is capped, not hopeful.
    const many = Array.from({ length: 400 }, (_, i) =>
      clip({ file: `/c${i}.wav`, startSec: 0, durationSec: 60 }),
    );
    const got = planChunks(many, 0, OPTS);
    expect(got.length).toBe(chunkCapacity());
    // …and the cap keeps the nearest ones, not an arbitrary prefix.
    expect(got.every((r) => r.chunkIndex <= 2)).toBe(true);
  });
});

describe("distanceToSpan", () => {
  it("is zero inside and the gap outside", () => {
    expect(distanceToSpan(5, 0, 10)).toBe(0);
    expect(distanceToSpan(-2, 0, 10)).toBe(2);
    expect(distanceToSpan(13, 0, 10)).toBe(3);
  });
});

describe("chooseEvictions", () => {
  function resident(over: Partial<ResidentChunk> & Pick<ResidentChunk, "chunkIndex">): ResidentChunk {
    const startSec = over.startSec ?? over.chunkIndex * CHUNK_SEC;
    return {
      file: "/a.wav",
      startSec,
      endSec: startSec + CHUNK_SEC,
      lastUsedSeq: 0,
      bytes: CHUNK_BYTES,
      ...over,
    };
  }

  it("evicts nothing while inside the budget", () => {
    const held = [resident({ chunkIndex: 0 }), resident({ chunkIndex: 1 })];
    expect(chooseEvictions(held, [], 0, BUDGET_BYTES)).toEqual([]);
  });

  it("drops the farthest chunk from the playhead first", () => {
    const held = [
      resident({ chunkIndex: 0 }), // 0–15 s
      resident({ chunkIndex: 40 }), // 600–615 s
      resident({ chunkIndex: 41 }), // 615–630 s
    ];
    // Room for two chunks only; the playhead is at 605 s.
    const dropped = chooseEvictions(held, [], 605, 2 * CHUNK_BYTES);
    expect(dropped).toEqual([{ file: "/a.wav", chunkIndex: 0 }]);
  });

  it("breaks a distance tie by least-recently-used", () => {
    const held = [
      resident({ chunkIndex: 10, file: "/a.wav", lastUsedSeq: 99 }),
      resident({ chunkIndex: 10, file: "/b.wav", lastUsedSeq: 3 }),
    ];
    // Both spans are identical, so only recency can decide. The stale one goes.
    const dropped = chooseEvictions(held, [], 5000, 1 * CHUNK_BYTES);
    expect(dropped).toEqual([{ file: "/b.wav", chunkIndex: 10 }]);
  });

  it("never evicts a chunk that is about to play", () => {
    const held = [
      resident({ chunkIndex: 0 }),
      resident({ chunkIndex: 40 }),
      resident({ chunkIndex: 41 }),
    ];
    // Chunk 0 is the farthest, but it is in `keep` — so the next-farthest goes instead.
    const keep = [{ file: "/a.wav", chunkIndex: 0 }];
    const dropped = chooseEvictions(held, keep, 605, 2 * CHUNK_BYTES);
    expect(dropped).toEqual([{ file: "/a.wav", chunkIndex: 41 }]);
  });

  it("leaves room for planned chunks that have not arrived yet", () => {
    // Two resident, budget for three, and two more incoming: one resident must go now,
    // or the fetch that follows overshoots the budget it was meant to respect.
    const held = [resident({ chunkIndex: 0 }), resident({ chunkIndex: 1 })];
    const keep = [
      { file: "/a.wav", chunkIndex: 40 },
      { file: "/a.wav", chunkIndex: 41 },
    ];
    const dropped = chooseEvictions(held, keep, 605, 3 * CHUNK_BYTES);
    expect(dropped).toHaveLength(1);
  });

  it("counts the real bytes, so short tail chunks are cheap", () => {
    const held = [
      resident({ chunkIndex: 0, bytes: 1000 }),
      resident({ chunkIndex: 1, bytes: 1000 }),
      resident({ chunkIndex: 2, bytes: 1000 }),
    ];
    expect(chooseEvictions(held, [], 0, 2500)).toHaveLength(1);
  });

  it("keys chunks by file and index", () => {
    expect(chunkKey("/a.wav", 3)).toBe("/a.wav#3");
    expect(chunkKey("/a.wav", 3)).not.toBe(chunkKey("/b.wav", 3));
  });
});
