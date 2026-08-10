/**
 * The fetch/cache layer between `WaveformCanvas` and the three shell commands S2 shipped
 * (`waveform_meta`, `waveform_level`, `regenerate_analysis`) — v0.3 S4.
 *
 * Kept free of React on purpose (like `geometry.ts`/`viewport.ts`/`waveformDraw.ts`): the
 * thing worth getting right here — never issuing the same `invoke` twice while one is
 * already in flight, and forgetting an entry cleanly on failure or on `invalidate` — is
 * pure bookkeeping, easiest to test without a component tree around it.
 *
 * Module-level `Map`s, not a React cache/context: every `Clip` on the timeline shares one
 * cache regardless of which one mounts first, panning a clip in and out of the
 * virtualization window (`geometry.ts` `visibleClips`) never re-fetches what it already
 * has, and `TimelineView`'s virtualization can mount and unmount `WaveformCanvas`
 * instances freely without losing the memo — the same reasoning `settings.ts` gives for
 * its own module-level `current`.
 */

import { invoke } from "@tauri-apps/api/core";
import { CACHE_MISSING, mapEngineError, type MappedError } from "../errors";
import type { Strings } from "../i18n";
import { getSettings } from "../settings";
import type { WaveformMeta } from "../types";

/** In-flight-or-settled fetches, keyed on file path. A rejected promise is a bad thing to
 *  cache forever (a transient IO error, a sweep that raced the read) — `drop()` below
 *  evicts on failure so the next mount gets a fresh try instead of a permanently poisoned
 *  memo. `invalidate()` does the same on purpose, after `regenerate_analysis` succeeds. */
const metaCache = new Map<string, Promise<WaveformMeta>>();

/** Keyed on `${file}\0${level}` — a NUL separator rather than `:` because file paths
 *  on Windows already contain `:` (a drive letter), and this must stay a clean 1:1 key. */
const levelCache = new Map<string, Promise<Uint8Array>>();

function levelKey(file: string, level: number): string {
  return `${file}\0${level}`;
}

/** Every waveform read goes through the settings' cache dir, exactly like `scan_inputs`/
 *  `cache_status` elsewhere in the app — `null` means "the engine's own OS-default
 *  location", which is what an untouched install has. */
function cacheDir(): string | null {
  return getSettings().cacheDir;
}

/* ── The meta queue (V05-W5, D-072) ─────────────────────────────────────────────────────
 *
 * Dedup per file was the ONLY thing standing between the timeline and the shell. On the
 * owner's 386-file drop every clip mounts a `WaveformCanvas` whose mount effect calls
 * `fetchWaveformMeta` — 386 distinct files, so the memo deduped nothing, and 386 `invoke`s
 * went out in one commit. Each of them crosses the IPC boundary, takes a Tokio task and a
 * cache-dir stat, and (before the sync has run) comes back `cache_missing`.
 *
 * The fix is a queue with a concurrency cap, drained from an idle callback. Three
 * properties, and each one is there for its own reason:
 *
 *   - **the cap** bounds what is outstanding at once, so the shell sees a trickle instead
 *     of a flood however many clips are on screen;
 *   - **the idle scheduling** puts the first batch behind the commit that mounted the
 *     clips, so the boxes, the ruler and the panel paint before anything is asked of the
 *     backend — a drop's first frame is not owed a waveform;
 *   - **the drop** (see {@link releaseWaveformMeta}) means a request whose canvas unmounted
 *     while it was still waiting in line is never sent at all. Panning across a card dump
 *     recycles the virtualization window many times a second, and a queue that faithfully
 *     issues every request it was ever handed is a slower storm, not a smaller one.
 *
 * The dedup is unchanged and still sits in front of all of it: `metaCache` is consulted
 * first, and a queued entry IS its file's `metaCache` entry.
 */

/** How many `waveform_meta` reads may be outstanding at once. Six is the same order as the
 *  engine's own decode parallelism and comfortably below any plausible IPC saturation; the
 *  number that matters is that it is a constant rather than "however many clips there
 *  are". */
export const META_CONCURRENCY = 6;

/** Upper bound on how long the drain may sit in the idle queue. `requestIdleCallback` with
 *  no timeout can be starved indefinitely by a busy main thread — which is exactly the
 *  state a freshly-dropped card dump is in — and a waveform that never arrives is worse
 *  than one that arrives a frame late. */
const IDLE_TIMEOUT_MS = 150;

interface QueuedMeta {
  file: string;
  /** How many live consumers are waiting for this. Dropped when it reaches zero. */
  waiters: number;
  promise: Promise<WaveformMeta>;
  resolve: (meta: WaveformMeta) => void;
  reject: (error: unknown) => void;
}

/** Waiting to be issued, in the order they were asked for. */
const metaQueue: QueuedMeta[] = [];
/** The same entries by file, so a release can find one in O(1). An entry leaves this map
 *  the moment it is issued: from then on it can no longer be dropped, only awaited. */
const queuedMeta = new Map<string, QueuedMeta>();
let metaInFlight = 0;
let drainScheduled = false;

/** The rejection a dropped request settles with. Never reaches a screen: the only way an
 *  entry is dropped is that every consumer of it has already cancelled. */
const DROPPED = "cancelled: waveform meta request dropped before it was issued";

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  const run = () => {
    drainScheduled = false;
    drainMetaQueue();
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof idle === "function") idle(run, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(run, 0);
}

function drainMetaQueue(): void {
  while (metaInFlight < META_CONCURRENCY && metaQueue.length > 0) {
    const entry = metaQueue.shift()!;
    queuedMeta.delete(entry.file);
    metaInFlight += 1;
    // `Promise.resolve` + `try` around the call, not around the await: a synchronous throw
    // out of `invoke` (a shell that is not there at all) would otherwise leave
    // `metaInFlight` incremented forever and stall every later drain — the queue's own
    // version of a leaked permit.
    let request: Promise<WaveformMeta>;
    try {
      request = Promise.resolve(
        invoke<WaveformMeta>("waveform_meta", { file: entry.file, cacheDir: cacheDir() }),
      );
    } catch (error) {
      metaInFlight -= 1;
      entry.reject(error);
      continue;
    }
    request.then(
      (meta) => {
        metaInFlight -= 1;
        entry.resolve(meta);
        scheduleDrain();
      },
      (error: unknown) => {
        metaInFlight -= 1;
        entry.reject(error);
        scheduleDrain();
      },
    );
  }
}

/**
 * The shape of a clip's waveform (bin counts per level, no bytes yet). Cached and
 * deduped: two `Clip`s for the same file (should not happen, but the virtualization
 * window remounting one while a fetch is still in flight very much can) share one
 * in-flight `invoke`.
 *
 * Since V05-W5 (D-072) the `invoke` does not go out here — the request joins the queue
 * above and is issued when the queue reaches it. Every caller must pair this with exactly
 * one {@link releaseWaveformMeta} when it stops caring about the answer.
 */
export function fetchWaveformMeta(file: string): Promise<WaveformMeta> {
  const cached = metaCache.get(file);
  if (cached) {
    // Still in line: one more consumer is waiting for it, so it takes one more release to
    // drop it. Already issued: there is nothing left to drop and nothing to count.
    const queued = queuedMeta.get(file);
    if (queued) queued.waiters += 1;
    return cached;
  }

  let resolve!: (meta: WaveformMeta) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WaveformMeta>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {
    // A rejected fetch is not a fact worth remembering forever — see the file header.
    if (metaCache.get(file) === promise) metaCache.delete(file);
  });
  metaCache.set(file, promise);
  const entry: QueuedMeta = { file, waiters: 1, promise, resolve, reject };
  queuedMeta.set(file, entry);
  metaQueue.push(entry);
  scheduleDrain();
  return promise;
}

/**
 * One consumer has stopped waiting for `file`'s meta.
 *
 * When the last one goes and the request has not been issued yet, it is removed from the
 * queue and never sent. That is the half of D-072 a cap alone does not buy: a pan across a
 * 386-file drop mounts and unmounts hundreds of canvases a second, and every one of them
 * would otherwise leave a request behind for a clip that is no longer on screen.
 *
 * A request already in flight is left alone — `invoke` has no cancellation
 * (`app/src/invoke.ts`), so there is nothing to stop, and its answer is worth memoising for
 * whoever pans back.
 */
export function releaseWaveformMeta(file: string): void {
  const entry = queuedMeta.get(file);
  if (!entry) return;
  entry.waiters -= 1;
  if (entry.waiters > 0) return;
  queuedMeta.delete(file);
  const index = metaQueue.indexOf(entry);
  if (index >= 0) metaQueue.splice(index, 1);
  if (metaCache.get(file) === entry.promise) metaCache.delete(file);
  entry.reject(DROPPED);
}

/**
 * One level's bins, as `[peak, rms]` `u8` pairs (already unwrapped from the
 * `ArrayBuffer` `invoke("waveform_level", …)` resolves to — D-052's binary-IPC path).
 */
export function fetchWaveformLevel(file: string, level: number): Promise<Uint8Array> {
  const key = levelKey(file, level);
  const cached = levelCache.get(key);
  if (cached) return cached;
  const promise = invoke<ArrayBuffer>("waveform_level", { file, level, cacheDir: cacheDir() }).then(
    (buf) => new Uint8Array(buf),
  );
  promise.catch(() => {
    if (levelCache.get(key) === promise) levelCache.delete(key);
  });
  levelCache.set(key, promise);
  return promise;
}

/**
 * Drops every cached fetch for `file` — meta and every level. Called after a successful
 * `regenerateAnalysis`, whose whole point is that the old answers (a `cacheMissing`
 * rejection, or bytes from a since-evicted entry) are stale and the next read must go
 * back to the shell rather than replay the memo.
 */
export function invalidate(file: string): void {
  // Deliberately does NOT touch the queue (V05-W5, D-072). A queued entry is somebody's
  // outstanding promise, and rejecting it here would raise an error on a clip whose only
  // crime was to be mid-read when its own regenerate landed — `runRegenerate` calls this
  // one line before `loadMeta()`, which cancels first and releases the entry properly. The
  // queued read simply answers whoever is still holding it; the next `fetchWaveformMeta`
  // queues a fresh one because the memo is gone.
  metaCache.delete(file);
  const prefix = `${file}\0`;
  for (const key of levelCache.keys()) {
    if (key.startsWith(prefix)) levelCache.delete(key);
  }
}

/* ── The epoch (V05-W1, D-064) ─────────────────────────────────────────────────────────
 *
 * `invalidate(file)` drops a memo, but nothing makes a mounted component go back and LOOK.
 * `WaveformCanvas` only re-reads on a file change, a regenerate, a `pending → ready`
 * transition or a zoom-bucket change — so a clip that met a `cache_missing` rejection
 * before a sync ran held that answer for the rest of the session, and the waveforms the
 * sync had just written never appeared. Dropping the memo and re-rendering the component
 * are two halves of one job, and the second half had no wire.
 *
 * The epoch is that wire, in the smallest form that cannot go stale: a module counter that
 * `invalidateAll()` bumps, published through the same `useSyncExternalStore` shape
 * `playhead.ts` uses. A consumer that includes it in its read's dependencies re-reads once
 * per wholesale invalidation and never holds a rejection forever — the whole class, not
 * just the instance this decision was written for.
 */

let epoch = 0;
const epochListeners = new Set<() => void>();

/**
 * Forgets every cached fetch, for every file, and bumps the epoch so every mounted
 * consumer re-reads exactly once.
 *
 * Called when a run has rewritten the cache underneath the whole timeline (`App.tsx`, on
 * `sync/done` and on a sync that failed or was cancelled): a sync extracts the analysis
 * audio for every file in it, so afterwards *every* clip's cached answer — a rejection or
 * a set of bins — is a claim about a cache that no longer exists.
 */
export function invalidateAll(): void {
  metaCache.clear();
  levelCache.clear();
  epoch += 1;
  for (const listener of epochListeners) listener();
}

export function subscribeEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

/** The current epoch. Monotonic; only its CHANGES mean anything. */
export function getEpoch(): number {
  return epoch;
}

/**
 * The cache-miss affordance's action (D-052): re-extract this one file's analysis audio.
 * Never cached — a regenerate is an explicit user action each time, not a read to memo.
 * Rejects with the shell's raw error string, same as every other `invoke` here; the guard
 * busy refusal (`"busy: …"`, D-046) surfaces this way when a sync or another maintenance
 * pass is already running.
 */
export function regenerateAnalysis(file: string): Promise<void> {
  return invoke<void>("regenerate_analysis", { file, cacheDir: cacheDir() });
}

export type WaveformErrorKind = "cacheMissing" | "busy" | "other";

export interface WaveformError {
  kind: WaveformErrorKind;
  /** The detail, for the control's `title` — `errors.ts`'s real `cacheMissing` copy for
   *  that kind, the engine's raw refusal for `busy` (see below), otherwise the same
   *  generic mapping every other engine error in the app gets (§7.5: the raw detail is
   *  kept, never swallowed into a bare "something went wrong"). NOT the visible label:
   *  `WaveformCanvas` chooses that from `kind`. */
  text: string;
  /** Only set for `cacheMissing` — the source file the regenerate button should name. */
  path?: string;
}

/** Stable prefix on the D-046 activity-guard refusal (`ActivityGuard::begin` in
 *  `lib.rs`) — `"busy: sync in progress"` / `"busy: cache maintenance in progress"`.
 *  Matched the same way `errors.ts` matches every other stable engine prefix (D-030). */
export const BUSY_PREFIX = "busy:";

function rawMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Test hook: drop every cached fetch, both maps — settings.ts's `reloadSettingsForTest`
 *  pattern. The caches are module-level by design (see the file header), so without this
 *  a suite exercising the same file path across multiple `it`s would see later calls
 *  silently served from an earlier test's cache instead of hitting the mock again. */
export function resetWaveformCachesForTest(): void {
  metaCache.clear();
  levelCache.clear();
  // The queue is module state too, and a test that left three entries in line would hand
  // them to the NEXT test's mock (V05-W5, D-072). The in-flight counter goes with them:
  // leaving it at 6 would stall every later drain.
  metaQueue.length = 0;
  queuedMeta.clear();
  metaInFlight = 0;
}

/** Test hook: how many `waveform_meta` requests are waiting in line, and how many are
 *  outstanding. The queue's whole purpose is a number, so the number is observable. */
export function metaQueueStateForTest(): { queued: number; inFlight: number } {
  return { queued: metaQueue.length, inFlight: metaInFlight };
}

/**
 * Sorts a rejection from any of the three commands above into the three states
 * `WaveformCanvas` actually branches on:
 *
 * - `cacheMissing` — regenerable, gets the button (`errors.ts`'s real copy for it).
 * - `busy` — a `regenerateAnalysis` call that lost the D-046 race; retryable once the
 *   sync/maintenance pass in front of it finishes. It gets its OWN copy (`waveformBusy`):
 *   `mapEngineError` has no busy branch, so routing it through there fell all the way to
 *   `errUnknown`, and a Norwegian UI showed «Noe gikk galt: busy: sync in progress» —
 *   English engine text, crash-shaped wording for an expected self-clearing condition,
 *   and far too long for a slot that is ~28 px tall and cannot wrap. The raw detail is
 *   not lost: `WaveformCanvas` puts `text` in the control's `title`.
 * - `other` — anything else (a genuinely unreadable source file, an unexpected shell
 *   error): shown as unavailable, no regenerate button offered for a problem regenerating
 *   cannot fix.
 */
export function classifyWaveformError(e: unknown, t: Strings): WaveformError {
  const raw = rawMessage(e);
  if (raw.includes(CACHE_MISSING)) {
    const mapped: MappedError = mapEngineError(raw, t);
    if (mapped.kind === "cacheMissing") {
      return { kind: "cacheMissing", text: mapped.text, path: mapped.path };
    }
  }
  if (raw.includes(BUSY_PREFIX)) {
    return { kind: "busy", text: raw };
  }
  return { kind: "other", text: mapEngineError(raw, t).text };
}
