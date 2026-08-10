import { memo } from "react";
import type { Strings } from "../../i18n";
import { msToX, type TimelineView } from "../../timeline/geometry";
import type { ClipSpan } from "../../timeline/laneLayout";
import { usePlayheadInsideSpan } from "../../timeline/playhead";
import { basename } from "../../types";
import type { Placement } from "../../types";
import { WaveformCanvas } from "./WaveformCanvas";

/** Narrower than this and the box is a tick mark, not a clip — but still there. */
const MIN_CLIP_PX = 3;

/** How much of a clip stays label-free at its right end when the label slides. */
const LABEL_KEEP_PX = 36;

/**
 * One placed file, as a box on its sub-track. Position and width come from the
 * shared view state, so the clip's pixels are a pure function of zoom/pan — no
 * percentages, no "relative to the widest clip" arithmetic like the old lanes.
 *
 * Green means placed and quiet, orange means placed with something to say; the
 * §9.4 colour language (PluralEyes', kept) survives the rewrite unchanged, as
 * does the accessible name, which still reads the REAL `offset_seconds` rather
 * than the timeline-local milliseconds the box is drawn at.
 */
export const Clip = memo(function Clip({
  t,
  span,
  placement,
  view,
  durationUnknown = false,
  onSelect,
}: {
  t: Strings;
  span: ClipSpan;
  placement: Placement;
  view: TimelineView;
  /** The outcome carries no duration for this file — see the `clip--nodur` note below. */
  durationUnknown?: boolean;
  onSelect: (placement: Placement) => void;
}) {
  const left = msToX(span.startMs, view);
  const width = Math.max(MIN_CLIP_PX, (span.endMs - span.startMs) * view.pxPerMs);
  const name = basename(span.file);
  const hasWarnings = placement.warnings.length > 0;
  // Subscribed to the DERIVED boolean, so this re-renders when the playhead crosses this
  // clip's edge and not on any of the other 59 frames a second (`playhead.ts`).
  const underPlayhead = usePlayheadInsideSpan(span.startMs, span.endMs);
  // Zoomed in, a long clip starts far off the left edge — and its label would go
  // with it, leaving a row of anonymous coloured bars. Slide the label back to the
  // viewport edge instead, but never past the clip's own right end.
  const labelShift = Math.max(0, Math.min(-left, width - LABEL_KEEP_PX));

  // Stays a real `<button>` — S5's `TimelineView.onPointerDown` tells a clip click from a
  // background-pan gesture by `target.closest("button, select, label, .timeline__ruler")`,
  // so anything else here would silently turn every clip click into a pan-start instead.
  // That is also why the S4 regenerate affordance inside the waveform slot below is a
  // `role="button"` SPAN, not a nested `<button>`: the HTML parser un-nests a `<button>`
  // inside a `<button>` (the "in body" insertion mode has a dedicated rule for it), which
  // would silently break this component's own DOM, not just fail a validator.
  // A file with no `durations` entry has an endMs equal to its startMs, so it draws as the
  // MIN_CLIP_PX sliver — indistinguishable from a camera that recorded a fraction of a
  // second, and silently so (V03-S6, finding 15). It says what it is instead: in the
  // accessible name, in the tooltip, and as a dashed box the eye reads as "not a
  // measurement". The width is left alone on purpose — inventing one would be drawing a
  // duration the app does not know.
  const className = [
    "clip",
    hasWarnings ? "clip--warn" : "",
    durationUnknown ? "clip--nodur" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const offsetLabel = `${name}, ${t.offsetLabel} ${placement.offset_seconds.toFixed(1)} s`;

  return (
    <button
      type="button"
      className={className}
      style={{ left: `${left}px`, width: `${width}px` }}
      onClick={() => onSelect(placement)}
      // The offset pattern is the §9.4 accessible name and stays exactly as it was; the
      // unknown-duration note is appended rather than replacing it.
      aria-label={durationUnknown ? `${offsetLabel} — ${t.clipDurationUnknown}` : offsetLabel}
      // "The playhead is inside this clip" — `aria-current="time"` is the one value in the
      // enumeration that means a temporal position, which is exactly what this is.
      aria-current={underPlayhead ? "time" : undefined}
      title={durationUnknown ? `${name} — ${t.clipDurationUnknown}` : name}
    >
      {/* v0.3 S4: the peaks canvas (or its regenerate/status affordance) fills this slot,
          behind the label. */}
      <span className="clip__waveform" data-waveform-slot="">
        <WaveformCanvas t={t} file={span.file} span={span} view={view} />
      </span>
      <span className="clip__name" style={{ transform: `translateX(${labelShift}px)` }}>
        {name}
      </span>
    </button>
  );
});
