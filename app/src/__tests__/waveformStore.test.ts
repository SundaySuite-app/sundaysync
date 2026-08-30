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
  META_CONCURRENCY,
  metaQueueStateForTest,
  regenerateAnalysis,
  releaseWaveformMeta,
  resetWaveformCachesForTest,
  subscribeEpoch,
} from "../timeline/waveformStore";

const FILE_A = "/Users/e2e/shoot/CamA/C0001.MP4";
const FILE_B = "/Users/e2e/shoot/CamB/C0002.MP4";
const META = { totalSamples: 12_000, levels: [{ binSamples: 120, bins: 100 }] };

/**
 * Let the idle-scheduled meta queue run (V05-W5, D-072).
 *
 * Since the queue landed, `fetchWaveformMeta` does not `invoke` on the calling turn — it
 * puts the request in line and asks for an idle callback. jsdom has no
 * `requestIdleCallback`, so the store falls back to `setTimeout(…, 0)`; one macrotask per
 * batch, plus a turn for the re-schedule each settled request triggers.
 *
 * Every `toHaveBeenCalledTimes` below that used to read straight after the call now reads
 * after this. What is being asserted is unchanged (one invoke per file, none for a dropped
 * request); WHEN the invoke happens is what the queue deliberately changed.
 */
async function drain(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

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
    await drain();
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

  it("does not disturb the dedup within one epoch", async () => {
    // The epoch is a reason to look AGAIN, not a reason to look twice at once: two clips
    // for the same file after an invalidation still share one in-flight invoke.
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    invalidateAll();

    void fetchWaveformMeta(FILE_A);
    void fetchWaveformMeta(FILE_A);
    await drain();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ── V05-W5, D-072: the queue ───────────────────────────────────────────────────────────
//
// The storm this exists for: 386 clips mount, each calls `fetchWaveformMeta` for its own
// file, the per-file dedup matches nothing because there are 386 distinct files, and 386
// `invoke`s cross the IPC boundary in one commit.

describe("the meta queue", () => {
  /** A `waveform_meta` mock that never settles, so everything issued stays outstanding and
   *  the cap is observable as a call count. */
  function stallingInvoke(): void {
    invokeMock.mockImplementation(() => new Promise(() => {}));
  }

  function files(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `/nas/cam/C${String(i).padStart(4, "0")}.MP4`);
  }

  it("issues at most META_CONCURRENCY reads at once, however many clips ask", async () => {
    stallingInvoke();
    for (const file of files(386)) void fetchWaveformMeta(file);
    await drain();
    // The whole point, in one number: 386 asked, six went out.
    expect(invokeMock).toHaveBeenCalledTimes(META_CONCURRENCY);
    expect(metaQueueStateForTest()).toEqual({
      queued: 386 - META_CONCURRENCY,
      inFlight: META_CONCURRENCY,
    });
  });

  it("lets the next request through as each one settles, so the queue really drains", async () => {
    const settle: ((value: unknown) => void)[] = [];
    invokeMock.mockImplementation(() => new Promise((resolve) => settle.push(resolve)));

    const all = files(10).map((file) => fetchWaveformMeta(file));
    await drain();
    expect(invokeMock).toHaveBeenCalledTimes(META_CONCURRENCY);

    for (const resolve of [...settle]) resolve(META);
    await drain();
    expect(invokeMock).toHaveBeenCalledTimes(10);

    for (const resolve of settle.slice(META_CONCURRENCY)) resolve(META);
    await Promise.all(all);
    expect(metaQueueStateForTest()).toEqual({ queued: 0, inFlight: 0 });
  });

  it("a rejection releases its slot too — one unreadable file must not stall the rest", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { file: string }) =>
      args.file.endsWith("C0000.MP4") ? Promise.reject("cache_missing:" + args.file) : Promise.resolve(META),
    );
    const all = files(20).map((file) => fetchWaveformMeta(file).catch(() => null));
    await Promise.all(all);
    expect(invokeMock).toHaveBeenCalledTimes(20);
    expect(metaQueueStateForTest()).toEqual({ queued: 0, inFlight: 0 });
  });

  it("a request whose canvas unmounted before it was issued is never sent", async () => {
    stallingInvoke();
    const queued = files(50);
    for (const file of queued) void fetchWaveformMeta(file).catch(() => {});
    // Everything past the cap is still in line — the virtualization window recycles and
    // those canvases go away before their turn comes.
    for (const file of queued.slice(META_CONCURRENCY)) releaseWaveformMeta(file);
    await drain();

    expect(invokeMock).toHaveBeenCalledTimes(META_CONCURRENCY);
    expect(metaQueueStateForTest()).toEqual({ queued: 0, inFlight: META_CONCURRENCY });
    for (const file of queued.slice(META_CONCURRENCY)) {
      expect(invokeMock).not.toHaveBeenCalledWith("waveform_meta", { file, cacheDir: null });
    }
  });

  it("a dropped request is forgotten, so a clip that pans back asks again", async () => {
    stallingInvoke();
    const p = fetchWaveformMeta(FILE_A).catch(() => "dropped");
    releaseWaveformMeta(FILE_A);
    expect(await p).toBe("dropped");

    invokeMock.mockReset();
    invokeMock.mockResolvedValue(META);
    await expect(fetchWaveformMeta(FILE_A)).resolves.toEqual(META);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("two consumers of one queued request take two releases to drop it", async () => {
    stallingInvoke();
    // Fill the cap so FILE_A genuinely waits in line.
    for (const file of files(META_CONCURRENCY)) void fetchWaveformMeta(file);
    await drain();
    const first = fetchWaveformMeta(FILE_A);
    const second = fetchWaveformMeta(FILE_A);
    expect(first).toBe(second);

    releaseWaveformMeta(FILE_A);
    expect(metaQueueStateForTest().queued).toBe(1); // one consumer left; still wanted

    releaseWaveformMeta(FILE_A);
    expect(metaQueueStateForTest().queued).toBe(0);
    await expect(first).rejects.toBeTruthy();
  });

  it("releasing an already-issued request is a no-op — there is nothing left to stop", async () => {
    stallingInvoke();
    void fetchWaveformMeta(FILE_A);
    await drain();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    releaseWaveformMeta(FILE_A);
    releaseWaveformMeta(FILE_A);
    expect(metaQueueStateForTest()).toEqual({ queued: 0, inFlight: 1 });
  });

  it("nothing is issued on the calling turn — the first frame is not owed a waveform", () => {
    stallingInvoke();
    for (const file of files(20)) void fetchWaveformMeta(file);
    expect(invokeMock).not.toHaveBeenCalled();
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

  it("maps a D-046 busy refusal to kind busy, named in the operator's language", () => {
    // R/D-094: the detail used to be the RAW rejection, because the mapping had no busy
    // branch to send it to. It has one now — per activity — so the tooltip this text ends
    // up in (`WaveformCanvas`'s `title`) is Norwegian too, and nothing is lost: the
    // sentence says which activity is holding the slot, which is all the raw string said.
    const err = classifyWaveformError("busy: sync in progress", nb);
    expect(err.kind).toBe("busy");
    expect(err.text).toBe(nb.errBusySync);
    expect(err.text).not.toContain("busy: sync in progress");
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
