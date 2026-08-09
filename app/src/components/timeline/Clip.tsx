import { memo } from "react";
import type { Strings } from "../../i18n";
import { msToX, type TimelineView } from "../../timeline/geometry";
import type { ClipSpan } from "../../timeline/laneLayout";
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
  onSelect,
}: {
  t: Strings;
  span: ClipSpan;
  placement: Placement;
  view: TimelineView;
  onSelect: (placement: Placement) => void;
}) {
  const left = msToX(span.startMs, view);
  const width = Math.max(MIN_CLIP_PX, (span.endMs - span.startMs) * view.pxPerMs);
  const name = basename(span.file);
  const hasWarnings = placement.warnings.length > 0;
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
  return (
    <button
      type="button"
      className={`clip${hasWarnings ? " clip--warn" : ""}`}
      style={{ left: `${left}px`, width: `${width}px` }}
      onClick={() => onSelect(placement)}
      aria-label={`${name}, ${t.offsetLabel} ${placement.offset_seconds.toFixed(1)} s`}
      title={name}
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
