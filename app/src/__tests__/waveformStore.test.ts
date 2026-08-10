import { beforeEach, describe, expect, it, vi } from "vitest";

// Same shape as invoke.test.ts: mock the Tauri module so the test controls what "the
// backend" answers, hoisted so the mock factory can see the spy.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { nb } from "../i18n";
import { reloadSettingsForTest, saveSettingsNow } from "../settings";
import {
  classifyWaveformError,
  fetchWaveformLevel,
  fetchWaveformMeta,
  getEpoch,
  invalidate,
  invalidateAll,
  regenerateAnalysis,
  resetWaveformCachesForTest,
  subscribeEpoch,
} from "../timeline/waveformStore";

const FILE_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const FILE_B = "/Users/e2e/shoot/CamB/C0002.MP4";
const META = { totalSamples: 12_000, levels: [{ binSamples: 120, bins: 100 }] };

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  reloadSettingsForTest();
  // The caches inside waveformStore.ts are module-level by design (see its file header)
  // — reset them so one test's successful fetch never silently answers a later test's
  // call to the same file path without hitting the mock.
  resetWaveformCachesForTest();
});

describe("fetchWaveformMeta", () => {
  it("dedupes concurrent calls for the same file into one invoke", async () => {
    let resolveInvoke!: (v: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise((r) => (resolveInvoke = r)));

    const a = fetchWaveformMeta(FILE_A);
    const b = fetchWaveformMeta(FILE_A);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveInvoke(META);
    await expect(a).resolves.toEqual(META);
    await expect(b).resolves.toEqual(META);
    // Same cached promise, not just equal values.
    expect(a).toBe(b);
  });

  it("passes the settings cache dir through to the invoke args", async () => {
    saveSettingsNow({ cacheDir: "/custom/cache" });
    invokeMock.mockResolvedValueOnce(META);
    await fetchWaveformMeta(FILE_A);
    expect(invokeMock).toHaveBeenCalledWith("waveform_meta", {
      file: FILE_A,
      cacheDir: "/custom/cache",
    });
  });

  it("does not cache a rejection — a later call retries against the backend", async () => {
    invokeMock.mockRejectedValueOnce("cache_missing:" + FILE_A);
    await expect(fetchWaveformMeta(FILE_A)).rejects.toBe("cache_missing:" + FILE_A);

    invokeMock.mockResolvedValueOnce(META);
    await expect(fetchWaveformMeta(FILE_A)).resolves.toEqual(META);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("different files never share a cache entry", async () => {
    invokeMock.mockResolvedValueOnce(META);
    invokeMock.mockResolvedValueOnce({ ...META, totalSamples: 99 });
    const a = await fetchWaveformMeta(FILE_A);
    const b = await fetchWaveformMeta(FILE_B);
    expect(a.totalSamples).toBe(12_000);
    expect(b.totalSamples).toBe(99);
  });
});

describe("fetchWaveformLevel", () => {
  it("unwraps the ArrayBuffer into a Uint8Array", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]).buffer;
    invokeMock.mockResolvedValueOnce(bytes);
    const level = await fetchWaveformLevel(FILE_A, 0);
    expect(level).toBeInstanceOf(Uint8Array);
    expect(Array.from(level)).toEqual([10, 20, 30, 40]);
  });

  it("dedupes by file AND level — level 0 and level 1 fetch independently", async () => {
    let resolve0!: (v: unknown) => void;
    let resolve1!: (v: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolve0 = r)));
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolve1 = r)));

    const p0a = fetchWaveformLevel(FILE_A, 0);
    const p0b = fetchWaveformLevel(FILE_A, 0);
    const p1 = fetchWaveformLevel(FILE_A, 1);
    expect(invokeMock).toHaveBeenCalledTimes(2); // level 0 deduped, level 1 separate

    resolve0(new Uint8Array([1]).buffer);
    resolve1(new Uint8Array([2]).buffer);
    expect(await p0a).toEqual(await p0b);
    expect(Array.from(await p1)).toEqual([2]);
  });

  it("a file path containing a colon (Windows drive letter) still keys cleanly", async () => {
    const winFile = "C:\\Users\\kari\\Opptak\\C0001.MP4";
    invokeMock.mockResolvedValueOnce(new Uint8Array([5]).buffer);
    invokeMock.mockResolvedValueOnce(new Uint8Array([6]).buffer);
    const level0 = await fetchWaveformLevel(winFile, 0);
    const level1 = await fetchWaveformLevel(winFile, 1);
    expect(Array.from(level0)).toEqual([5]);
    expect(Array.from(level1)).toEqual([6]);
  });
});

describe("invalidate", () => {
  it("drops the meta cache so the next fetch hits the backend again", async () => {
    invokeMock.mockResolvedValueOnce(META);
    await fetchWaveformMeta(FILE_A);
    invalidate(FILE_A);

    invokeMock.mockResolvedValueOnce({ ...META, totalSamples: 7 });
    const fresh = await fetchWaveformMeta(FILE_A);
    expect(fresh.totalSamples).toBe(7);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("drops every level cached for the file, but not other files' levels", async () => {
    invokeMock.mockResolvedValueOnce(new Uint8Array([1]).buffer);
    invokeMock.mockResolvedValueOnce(new Uint8Array([2]).buffer);
    invokeMock.mockResolvedValueOnce(new Uint8Array([9]).buffer); // FILE_B, untouched

    await fetchWaveformLevel(FILE_A, 0);
    await fetchWaveformLevel(FILE_A, 1);
    await fetchWaveformLevel(FILE_B, 0);

    invalidate(FILE_A);

    invokeMock.mockResolvedValueOnce(new Uint8Array([100]).buffer);
    const refetched = await fetchWaveformLevel(FILE_A, 0);
    expect(Array.from(refetched)).toEqual([100]); // re-fetched, not the stale [1]

    // FILE_B's level-0 fetch must not have been touched by FILE_A's invalidate.
    const stillCachedB = await fetchWaveformLevel(FILE_B, 0);
    expect(Array.from(stillCachedB)).toEqual([9]);
    expect(invokeMock).toHaveBeenCalledTimes(4); // 3 initial + 1 re-fetch, no extra for B
  });
});

// V05-W1, D-064. `invalidate()` forgets; the epoch is what makes a MOUNTED component go
// back and look. Both halves are needed and only the first one existed — which is why the
// waveforms a sync had just built never appeared: the memo was dropped and no clip ever
// asked again.

describe("invalidateAll and the epoch", () => {
  it("forgets every file, not just one", async () => {
    invokeMock.mockResolvedValueOnce(META);
    invokeMock.mockResolvedValueOnce(META);
    await fetchWaveformMeta(FILE_A);
    await fetchWaveformMeta(FILE_B);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    invalidateAll();

    invokeMock.mockResolvedValueOnce({ ...META, totalSamples: 7 });
    invokeMock.mockResolvedValueOnce({ ...META, totalSamples: 8 });
    expect((await fetchWaveformMeta(FILE_A)).totalSamples).toBe(7);
    expect((await fetchWaveformMeta(FILE_B)).totalSamples).toBe(8);
    expect(invokeMock).toHaveBeenCalledTimes(4);
  });

  it("forgets the level bytes too — a run rewrote those as well", async () => {
    invokeMock.mockResolvedValueOnce(new Uint8Array([1]).buffer);
    await fetchWaveformLevel(FILE_A, 0);

    invalidateAll();

    invokeMock.mockResolvedValueOnce(new Uint8Array([100]).buffer);
    expect(Array.from(await fetchWaveformLevel(FILE_A, 0))).toEqual([100]);
  });

  it("bumps the epoch once per call and tells every subscriber", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeEpoch(() => seen.push(getEpoch()));
    const before = getEpoch();

    invalidateAll();
    invalidateAll();

    expect(getEpoch()).toBe(before + 2);
    expect(seen).toEqual([before + 1, before + 2]);

    // Unsubscribing really stops it — a virtualized timeline mounts and unmounts these
    // constantly, and a leaked listener is a re-render of a clip that is not on screen.
    unsubscribe();
    invalidateAll();
    expect(seen).toEqual([before + 1, before + 2]);
  });

  it("does not disturb the dedup within one epoch", () => {
    // The epoch is a reason to look AGAIN, not a reason to look twice at once: two clips
    // for the same file after an invalidation still share one in-flight invoke.
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    invalidateAll();

    void fetchWaveformMeta(FILE_A);
    void fetchWaveformMeta(FILE_A);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("regenerateAnalysis", () => {
  it("invokes regenerate_analysis with the file and cache dir, never cached", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    invokeMock.mockResolvedValueOnce(undefined);
    await regenerateAnalysis(FILE_A);
    await regenerateAnalysis(FILE_A);
    expect(invokeMock).toHaveBeenCalledTimes(2); // no dedup — every call is a real action
    expect(invokeMock).toHaveBeenCalledWith("regenerate_analysis", {
      file: FILE_A,
      cacheDir: null,
    });
  });
});

describe("classifyWaveformError", () => {
  it("maps a cache_missing rejection to kind cacheMissing with the real copy and path", () => {
    const err = classifyWaveformError("cache_missing:" + FILE_A, nb);
    expect(err.kind).toBe("cacheMissing");
    expect(err.path).toBe(FILE_A);
    expect(err.text).toBe(nb.errCacheMissing);
  });

  it("maps a D-046 busy refusal to kind busy, carrying the raw detail", () => {
    const err = classifyWaveformError("busy: sync in progress", nb);
    expect(err.kind).toBe("busy");
    expect(err.text).toContain("busy: sync in progress");
  });

  it("maps the other maintenance-busy variant the same way", () => {
    const err = classifyWaveformError("busy: cache maintenance in progress", nb);
    expect(err.kind).toBe("busy");
  });

  it("maps anything else to kind other via the same generic mapping every engine error gets", () => {
    const err = classifyWaveformError("failed to read /x: no such file", nb);
    expect(err.kind).toBe("other");
    expect(err.text.length).toBeGreaterThan(0);
  });

  it("handles a rejection wrapped in an Error instance, same as mapEngineError's callers", () => {
    const err = classifyWaveformError(new Error("cache_missing:" + FILE_A), nb);
    expect(err.kind).toBe("cacheMissing");
    expect(err.path).toBe(FILE_A);
  });
});
