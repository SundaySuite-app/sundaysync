import { describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES } from "./pcmPlan";
import { PcmStore, type PlannedChunk, type ReadWindow } from "./pcmStore";
import { CHUNK_SAMPLES } from "./schedulePlan";

function planned(file: string, chunkIndex: number): PlannedChunk {
  return { file, chunkIndex, startSec: chunkIndex * 15, endSec: (chunkIndex + 1) * 15 };
}

/** A backend that hands back `total` samples per file, then nothing. */
function backend(total: number): ReadWindow {
  return async (_file, start, len) => {
    const from = Math.min(start, total);
    const to = Math.min(start + len, total);
    return new Float32Array(Math.max(0, to - from)).buffer;
  };
}

describe("PcmStore", () => {
  it("fetches a planned chunk once and answers `has` afterwards", async () => {
    const read = vi.fn(backend(CHUNK_SAMPLES * 3));
    const store = new PcmStore({ read });

    expect(store.has("/a.wav", 0)).toBe(false);
    await store.ensure([planned("/a.wav", 0), planned("/a.wav", 1)], 0);

    expect(store.has("/a.wav", 0)).toBe(true);
    expect(store.get("/a.wav", 1)!.length).toBe(CHUNK_SAMPLES);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith("/a.wav", 0, CHUNK_SAMPLES);
    expect(read).toHaveBeenCalledWith("/a.wav", CHUNK_SAMPLES, CHUNK_SAMPLES);

    // A second pass over the same plan is free.
    await store.ensure([planned("/a.wav", 0), planned("/a.wav", 1)], 0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates two overlapping ensures of the same chunk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = vi.fn(async () => {
      await gate;
      return new Float32Array(CHUNK_SAMPLES).buffer;
    });
    const store = new PcmStore({ read });

    const a = store.ensure([planned("/a.wav", 0)], 0);
    const b = store.ensure([planned("/a.wav", 0)], 0);
    release();
    await Promise.all([a, b]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(store.has("/a.wav", 0)).toBe(true);
  });

  it("stops asking past the end of a clip", async () => {
    // 1.5 chunks of audio: chunk 1 is short, chunk 2 does not exist.
    const read = vi.fn(backend(CHUNK_SAMPLES + CHUNK_SAMPLES / 2));
    const store = new PcmStore({ read });

    await store.ensure([planned("/a.wav", 0), planned("/a.wav", 1)], 0);
    expect(store.get("/a.wav", 1)!.length).toBe(CHUNK_SAMPLES / 2);

    await store.ensure([planned("/a.wav", 2), planned("/a.wav", 3)], 0);
    // A short read already told us where the clip ends; nothing beyond is requested.
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.has("/a.wav", 2)).toBe(false);
  });

  it("writes a file off for the session on cache_missing, exactly once", async () => {
    const onDead = vi.fn();
    let calls = 0;
    const read: ReadWindow = async () => {
      calls += 1;
      // The shell rejects with a bare string, the way real Tauri does.
      throw "cache_missing:/Users/e2e/shoot/CamA/C0001.MP4";
    };
    const store = new PcmStore({ read, onDead });

    await store.ensure([planned("/a.wav", 0)], 0);
    expect(store.isDead("/a.wav")).toBe(true);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("/a.wav", "cacheMissing");

    // No retry storm: a dead file is never asked for again.
    await store.ensure([planned("/a.wav", 0), planned("/a.wav", 1)], 0);
    expect(calls).toBe(1);
    expect(store.deadFiles()).toEqual(["/a.wav"]);
  });

  it("retries an ordinary IO failure instead of writing the file off", async () => {
    let calls = 0;
    const read: ReadWindow = async () => {
      calls += 1;
      if (calls === 1) throw "failed to read /cache/abc.f32: input/output error";
      return new Float32Array(CHUNK_SAMPLES).buffer;
    };
    const store = new PcmStore({ read });

    await store.ensure([planned("/a.wav", 0)], 0);
    expect(store.has("/a.wav", 0)).toBe(false);
    expect(store.isDead("/a.wav")).toBe(false);

    await store.ensure([planned("/a.wav", 0)], 0);
    expect(store.has("/a.wav", 0)).toBe(true);
  });

  it("drops a dead file's already-resident chunks", async () => {
    let fail = false;
    const read: ReadWindow = async () => {
      if (fail) throw "cache_missing:/a.wav";
      return new Float32Array(CHUNK_SAMPLES).buffer;
    };
    const store = new PcmStore({ read });
    await store.ensure([planned("/a.wav", 0)], 0);
    expect(store.residentBytes).toBe(CHUNK_BYTES);

    fail = true;
    await store.ensure([planned("/a.wav", 1)], 0);
    expect(store.has("/a.wav", 0)).toBe(false);
    expect(store.residentBytes).toBe(0);
  });

  it("honours the byte budget, keeping what is planned", async () => {
    const store = new PcmStore({ read: backend(CHUNK_SAMPLES * 10), budgetBytes: 2 * CHUNK_BYTES });

    await store.ensure([planned("/a.wav", 0), planned("/a.wav", 1)], 0);
    expect(store.residentCount).toBe(2);

    // The playhead has moved to chunk 5; chunk 0 is the farthest and goes.
    await store.ensure([planned("/a.wav", 5)], 80);
    expect(store.residentCount).toBeLessThanOrEqual(2);
    expect(store.has("/a.wav", 5)).toBe(true);
    expect(store.has("/a.wav", 0)).toBe(false);
    expect(store.residentBytes).toBeLessThanOrEqual(2 * CHUNK_BYTES);
  });

  it("announces arrivals so the scheduler can pick them up", async () => {
    const onArrived = vi.fn();
    const store = new PcmStore({ read: backend(CHUNK_SAMPLES * 2), onArrived });
    await store.ensure([planned("/a.wav", 0)], 0);
    expect(onArrived).toHaveBeenCalled();
  });

  it("forgets everything on clear", async () => {
    const store = new PcmStore({ read: backend(CHUNK_SAMPLES * 2) });
    await store.ensure([planned("/a.wav", 0)], 0);
    store.clear();
    expect(store.residentCount).toBe(0);
    expect(store.residentBytes).toBe(0);
    expect(store.has("/a.wav", 0)).toBe(false);
  });
});
