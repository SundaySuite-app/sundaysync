import type { Strings } from "../../i18n";
import type { UnsyncedReason, Warning } from "../../types";

/**
 * A §5 `Warning` as the operator's own language. Lifted unchanged out of the old
 * `ResultView.tsx` when the timeline replaced it (D-051); two components need it
 * now (the header's result-level warnings and the preview panel's per-clip ones), so
 * it lives on its own rather than being exported from one of them.
 *
 * The exhaustive switch is deliberate: adding a variant to `Warning` without a
 * string here is a type error, not a blank line in the UI.
 */
export function warningText(t: Strings, w: Warning): string {
  switch (w.code) {
    case "drift":
      return t.drift(w.projected_end_error_ms);
    case "metadata_mismatch":
      return t.metadataMismatch;
    case "mixed_fps":
      return t.mixedFps;
    case "frame_snap_residual":
      return t.frameSnap;
  }
}

/**
 * Why the engine (or the scan) would not use a file, in the operator's own language.
 *
 * The same four sentences were written out as a `Record<UnsyncedReason, string>` in
 * `ProblemsPopover` and again in `UnsyncedShelf`, and F needed them in two more places (the
 * pill's accessible name, and the inspector's line for a refused file). Four copies of one
 * mapping is four places for a new reason to be forgotten, so it lives beside `warningText`
 * for exactly the same stated purpose: the exhaustive switch makes a missing string a type
 * error rather than a blank line in the UI.
 */
export function reasonText(t: Strings, reason: UnsyncedReason): string {
  switch (reason) {
    case "low_confidence":
      return t.reasonLowConfidence;
    case "no_audio":
      return t.reasonNoAudio;
    case "decode_error":
      return t.reasonDecodeError;
    case "device_overlap":
      return t.reasonDeviceOverlap;
  }
}
