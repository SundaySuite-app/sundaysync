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

/**
 * The shape of a clip's waveform (bin counts per level, no bytes yet). Cached and
 * deduped: two `Clip`s for the same file (should not happen, but the virtualization
 * window remounting one while a fetch is still in flight very much can) share one
 * in-flight `invoke`.
 */
export function fetchWaveformMeta(file: string): Promise<WaveformMeta> {
  const cached = metaCache.get(file);
  if (cached) return cached;
  const promise = invoke<WaveformMeta>("waveform_meta", { file, cacheDir: cacheDir() });
  promise.catch(() => {
    // A rejected fetch is not a fact worth remembering forever — see the file header.
    if (metaCache.get(file) === promise) metaCache.delete(file);
  });
  metaCache.set(file, promise);
  return promise;
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
  metaCache.delete(file);
  const prefix = `${file}\0`;
  for (const key of levelCache.keys()) {
    if (key.startsWith(prefix)) levelCache.delete(key);
  }
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
const BUSY_PREFIX = "busy:";

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
