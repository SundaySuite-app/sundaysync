import { memo } from "react";
import type { Strings } from "../../i18n";
import { msToX, type TimelineView } from "../../timeline/geometry";
import type { ClipSpan } from "../../timeline/laneLayout";
import { basename } from "../../types";
import type { Placement } from "../../types";

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

  return (
    <button
      type="button"
      className={`clip${hasWarnings ? " clip--warn" : ""}`}
      style={{ left: `${left}px`, width: `${width}px` }}
      onClick={() => onSelect(placement)}
      aria-label={`${name}, ${t.offsetLabel} ${placement.offset_seconds.toFixed(1)} s`}
      title={name}
    >
      {/*
        Reserved for the waveform (v0.3 S4): the peaks canvas draws HERE, behind
        the label, filling the clip box. Empty and `aria-hidden` until then — a
        named slot beats S4 having to re-guess this component's internal layout.
      */}
      <span className="clip__waveform" data-waveform-slot="" aria-hidden="true" />
      <span className="clip__name" style={{ transform: `translateX(${labelShift}px)` }}>
        {name}
      </span>
    </button>
  );
});
