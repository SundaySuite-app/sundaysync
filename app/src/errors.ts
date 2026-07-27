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
  | { kind: "error"; text: string };

export function mapEngineError(raw: string, t: Strings): MappedError {
  if (raw.startsWith("cancelled")) {
    return { kind: "notice", text: t.noticeCancelled };
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
