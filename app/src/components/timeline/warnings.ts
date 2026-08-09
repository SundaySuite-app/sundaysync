import type { Strings } from "../../i18n";
import type { Warning } from "../../types";

/**
 * A §5 `Warning` as the operator's own language. Lifted unchanged out of the old
 * `ResultView.tsx` when the timeline replaced it (D-051); two components need it
 * now (the header's result-level warnings and `ClipDetail`'s per-clip ones), so
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
