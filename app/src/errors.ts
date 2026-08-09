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
 * a vague "something went wrong" with the detail thrown away helps nobody.
 */

import type { Strings } from "./i18n";

export type MappedError =
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  /**
   * V03-S2 (D-052): the clip has no analysis-cache entry, so its waveform cannot be
   * drawn *yet*. Not a failure — the cache is regenerable by definition, and
   * `regenerate_analysis` is one invoke away. Carries the clip path so the view can
   * name it and pass it straight back.
   *
   * `text` is present on every variant so existing consumers (`App.tsx` reads
   * `.text` unconditionally) keep compiling; the copy here is the raw-string fallback
   * until S4 lands the real "not built yet — regenerate?" affordance and its strings.
   */
  | { kind: "cacheMissing"; path: string; text: string };

/**
 * Prefix the shell puts on a missing-cache-entry refusal (`lib.rs`
 * `CACHE_MISSING_PREFIX`), followed by the source clip path.
 */
export const CACHE_MISSING = "cache_missing:";

export function mapEngineError(raw: string, t: Strings): MappedError {
  if (raw.startsWith("cancelled")) {
    return { kind: "notice", text: t.noticeCancelled };
  }
  // F14/F11: a client-side invoke timeout (invoke.ts). Recoverable — the user can retry —
  // so it is a notice, not a red crash. The `Error` prefix survives `String(e)` as
  // "Error: invoke-timeout: …", so match the label anywhere in the string.
  if (raw.includes("invoke-timeout")) {
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
    return { kind: "cacheMissing", path, text: t.errUnknown(raw) };
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
  return { kind: "error", text: t.errUnknown(raw) };
}
