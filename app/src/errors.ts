/**
 * Engine-error localisation — D-030.
 *
 * The engine's `Error` Display strings are stable thiserror templates
 * (crates/core/src/error.rs): "no input files were given", "ffmpeg sidecar
 * unavailable: {0}", "failed to read {path}: {source}", "cancelled",
 * "internal invariant violated: {0}". They are matched here by prefix — if one is ever
 * reworded, grep for it and this file trips first.
 *
 * `cancelled` maps to a *notice*, never an error: §7.4 distinguishes "you stopped this"
 * from "this broke", and the first build painted a red banner reading "cancelled" over
 * a user's own deliberate action.
 *
 * Unknown errors keep the raw text embedded — §7.5's honesty applies to failures too;
 * a vague "something went wrong" with the detail thrown away helps nobody. What the
 * fallback may never do is hand that raw text over *bare*: the engine speaks English, the
 * operator does not, and «no common audio: …» alone on a banner is the app changing
 * language mid-sentence. `errUnknown` is the frame that keeps it honest AND readable —
 * it says the tail is the engine quoting itself.
 *
 * ## Which engine strings get their own sentence (R, D-094)
 *
 * Every message below is one an operator can actually produce by using the app: dropping
 * the wrong folder in, pressing a button while a sync runs, pointing the cache at a
 * folder SundaySync never wrote. The ones deliberately left to the fallback are the ones
 * only a bug or a hostile caller can reach — argument-range refusals (`preview height …
 * is out of range`, `requested … samples`), the export-path guards the save dialog
 * already satisfies — where a hand-written Norwegian sentence would be a translation of a
 * condition no user can be in.
 */

import type { Strings } from "./i18n";

export type MappedError =
  | { kind: "notice"; text: string }
  /**
   * `unmapped` marks the §7.5 fallback — the branch that had no sentence of its own and
   * fell through to `errUnknown`. Callers that already own a frame of their own (the
   * updater's «Kunne ikke oppdatere: …») use it to avoid stacking two frames around one
   * message; nothing else needs to care.
   */
  | { kind: "error"; text: string; unmapped?: true }
  /**
   * V03-S2 (D-052): the clip has no analysis-cache entry, so its waveform cannot be
   * drawn *yet*. Not a failure — the cache is regenerable by definition, and
   * `regenerate_analysis` is one invoke away. Carries the clip path so the view can
   * name it and pass it straight back.
   *
   * `text` is present on every variant so existing consumers (`App.tsx` reads
   * `.text` unconditionally) keep compiling; `WaveformCanvas` (V03-S4) is the actual
   * consumer, via `waveformStore.ts`'s `classifyWaveformError`.
   */
  | { kind: "cacheMissing"; path: string; text: string };

/**
 * Prefix the shell puts on a missing-cache-entry refusal (`lib.rs`
 * `CACHE_MISSING_PREFIX`), followed by the source clip path.
 */
export const CACHE_MISSING = "cache_missing:";

/**
 * Prefix on the shell's D-046 activity-guard refusals (`lib.rs` `busy_message`) —
 * `"busy: sync in progress"`, `"busy: cache maintenance in progress"`,
 * `"busy: analysis in progress"`.
 *
 * It lives HERE rather than in `waveformStore.ts` (where it was) because it is not a
 * waveform concept: `clear_cache`, `enforce_cache_cap`, `run_sync` and `prewarm_analysis`
 * all earn the same refusal, and a constant only the waveform path could see is what let
 * the Settings buttons keep showing «Noe gikk galt: busy: sync in progress» long after the
 * clip had learned to say it properly. `waveformStore.ts` re-exports it for its callers.
 */
export const BUSY_PREFIX = "busy:";

export function mapEngineError(raw: string, t: Strings): MappedError {
  if (raw.startsWith("cancelled")) {
    return { kind: "notice", text: t.noticeCancelled };
  }
  // D-046: something else holds the single-activity slot. A *notice*, not an error, for
  // the same reason `cancelled` is one — nothing is broken, and the condition clears
  // itself. Which activity is named, because "wait" without "for what" is not an answer.
  if (raw.includes(BUSY_PREFIX)) {
    const what = raw.slice(raw.indexOf(BUSY_PREFIX) + BUSY_PREFIX.length).trim();
    const text = what.startsWith("sync")
      ? t.errBusySync
      : what.startsWith("cache maintenance")
        ? t.errBusyMaintenance
        : what.startsWith("analysis")
          ? t.errBusyPrewarm
          : t.errBusy;
    return { kind: "notice", text };
  }
  // F14/F11: a client-side invoke timeout (invoke.ts). Recoverable — the user can retry —
  // so it is a notice, not a red crash. The `Error` prefix survives `String(e)` as
  // "Error: invoke-timeout: …", so match the label anywhere in the string.
  // Two spellings of the same fact: `invoke.ts`'s client-side ceiling, and `update.ts`'s
  // own `withTimeout` ("update_check did not answer within 15000 ms"). Both are "ask
  // again", not "this broke".
  if (raw.includes("invoke-timeout") || raw.includes("did not answer within")) {
    return { kind: "notice", text: t.noticeTimeout };
  }
  // F6: the backend refused an export because the sources changed under it. The message
  // starts with this stable prefix (lib.rs STALE_EXPORT_MSG).
  if (raw.startsWith("the sources changed since this timeline was synced")) {
    return { kind: "error", text: t.errStaleExport };
  }
  // V03-S2/D-052: "the waveform is not built yet" — a state with a button, not a red
  // banner. Matched before the generic prefixes so it can never fall through to
  // `errUnknown` and read as a crash.
  if (raw.includes(CACHE_MISSING)) {
    const path = raw.slice(raw.indexOf(CACHE_MISSING) + CACHE_MISSING.length).trim();
    return { kind: "cacheMissing", path, text: t.errCacheMissing };
  }
  if (raw.startsWith("no input files")) {
    return { kind: "error", text: t.errNoInput };
  }
  if (raw.startsWith("ffmpeg sidecar unavailable")) {
    return { kind: "error", text: t.errSidecar };
  }
  if (raw.startsWith("failed to read ")) {
    // "failed to read {path}: {source}" — the path is the user-actionable part.
    const rest = raw.slice("failed to read ".length);
    const path = rest.split(": ")[0] ?? rest;
    return { kind: "error", text: t.errIo(path) };
  }
  if (raw.startsWith("internal invariant violated")) {
    // A bug report, not a user problem — keep the detail so it can be reported.
    const detail = raw.slice("internal invariant violated: ".length) || raw;
    return { kind: "error", text: t.errInvariant(detail) };
  }
  // S-8/D-032: a whole disk or a home directory dropped in. Not a broken file and not a
  // bug — a mis-drop, and the only message here whose answer is "pick a different folder".
  if (raw.startsWith("too many files to scan")) {
    const limit = /limit (\d+)/.exec(raw)?.[1] ?? "";
    return { kind: "error", text: t.errTooManyFiles(limit) };
  }
  // S-7/D-032: Clear pointed at a folder SundaySync never wrote. The path is the whole
  // point of the message — it is what the user has to change.
  if (raw.startsWith("refusing to clear ")) {
    const path = raw.slice("refusing to clear ".length).split(": ")[0] ?? raw;
    return { kind: "error", text: t.errNotACacheDir(path) };
  }
  // `export_snapshot` with an empty slot — the export button is gated on a result, so this
  // is the belt to that braces, and it still has to read as Norwegian if it ever fires.
  if (raw.startsWith("nothing has been synced")) {
    return { kind: "error", text: t.errNothingSynced };
  }
  // `regenerate_analysis` on a file ffmpeg cannot read, and the same command finding no
  // audio stream at all. Both name the file, because which file is the actionable half.
  if (raw.startsWith("could not decode ")) {
    const rest = raw.slice("could not decode ".length);
    return { kind: "error", text: t.errDecode(rest.split(": ")[0] ?? rest) };
  }
  if (raw.startsWith("nothing was extracted for ")) {
    return { kind: "error", text: t.errNoAudio(raw.slice("nothing was extracted for ".length)) };
  }
  // A panicked worker left a lock poisoned (`OnPoison::Reject`). A bug, but one with a
  // real user action attached — the state is gone and only a restart brings it back.
  if (raw.startsWith("internal state was poisoned")) {
    return { kind: "error", text: t.errPoisoned };
  }
  return { kind: "error", text: t.errUnknown(raw), unmapped: true };
}
