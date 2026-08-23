import type { ReactNode } from "react";
import type { Strings } from "../../i18n";
import { GearIcon } from "../icons";

/**
 * The 44 px top strip — row one of the «Ett rom» shell (V06-R1, D-074/D-081).
 *
 * Everything that used to stack down the page before the timeline lives on one line here:
 * the wordmark, the compact «Legg til», one sentence of summary, the single primary action
 * for the phase, and the gear. The point is not density for its own sake — it is that the
 * strip is **the same height in every phase**, so nothing below it moves when the phase
 * changes. A header that grew a button, then a progress bar, then an export row was the
 * whole reason the room used to jump three times per run.
 *
 * What goes in `actions` is the phase's own decision (App owns the phase machine); this
 * component owns only the shape. `summary` is a single already-composed string rather than
 * a set of counts, for the same reason: the strip must never grow a second line, and the
 * one place that can decide what fits is the place that knows what the phase is.
 */
export function TopStrip({
  t,
  /** The compact `DropZone` — `null` in the empty phase, where the stage carries the
   *  full-size one instead. Exactly one `DropZone` may be mounted at a time: its drag-drop
   *  listener is webview-global (see `DropZone.tsx`), so two would take every drop twice. */
  add,
  summary,
  actions,
  onSettings,
}: {
  t: Strings;
  add: ReactNode;
  summary: string | null;
  actions: ReactNode;
  onSettings: () => void;
}) {
  return (
    <header className="app__header">
      <h1>
        Sunday<span className="accent">Sync</span>
      </h1>
      {add}
      {/* Always rendered, even when there is nothing to say: an element that appears would
          re-flex the row and shift the primary action sideways under the operator's hand. */}
      <span className="strip__summary">{summary}</span>
      {actions}
      <button
        type="button"
        className="iconbtn"
        onClick={onSettings}
        aria-label={t.settings}
      >
        <GearIcon />
      </button>
    </header>
  );
}
