import { memo } from "react";
import type { Strings } from "../../i18n";
import type { PrewarmStatus } from "../../state";
import { formatTimecode, msToX, type TimelineView } from "../../timeline/geometry";
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
 * One file, as a box on its sub-track. Position and width come from the shared
 * view state, so the clip's pixels are a pure function of zoom/pan — no
 * percentages, no "relative to the widest clip" arithmetic like the old lanes.
 *
 * Green means placed and quiet, orange means placed with something to say; the
 * §9.4 colour language (PluralEyes', kept) survives the rewrite unchanged, as
 * does the accessible name, which still reads the REAL `offset_seconds` rather
 * than the timeline-local milliseconds the box is drawn at.
 *
 * **Pre-sync (v0.4, D-061): `placement` is null.** The same box is drawn where the
 * file's own creation timestamp says it belongs, in a neutral tone that is
 * deliberately NOT the placed green — green is a claim the engine has not made
 * yet — and the button is `disabled`, because there is no placement to open a
 * detail dialog on. It stays a `<button>` rather than becoming a `<div>` on
 * purpose: the element type is what React reconciles on, and a clip that swapped
 * tags at the sources→result boundary would tear down its own subtree (waveform
 * state included) at exactly the moment the timeline is supposed to be showing
 * continuity.
 */
export const Clip = memo(function Clip({
  t,
  span,
  placement,
  view,
  durationUnknown = false,
  startUnknown = false,
  analysisStatus = null,
  onSelect,
}: {
  t: Strings;
  span: ClipSpan;
  /** Null before a sync has placed this file — see the note above. */
  placement: Placement | null;
  view: TimelineView;
  /** The outcome carries no duration for this file — see the `clip--nodur` note below. */
  durationUnknown?: boolean;
  /** Pre-sync only: nothing in the file said when it started, so it sits at zero. */
  startUnknown?: boolean;
  /** Where the background pre-analysis is with this file (v0.4, D-062) — passed straight
   *  through to the waveform slot, which is the only thing that behaves differently. One
   *  file's status rather than the whole prewarm map on purpose: this component is
   *  `memo`ised, and a map would hand every clip a fresh prop on every `prewarm:file`
   *  event, re-rendering the entire timeline once per decoded file. */
  analysisStatus?: PrewarmStatus | null;
  onSelect: (placement: Placement) => void;
}) {
  const left = msToX(span.startMs, view);
  const width = Math.max(MIN_CLIP_PX, (span.endMs - span.startMs) * view.pxPerMs);
  const name = basename(span.file);
  const hasWarnings = placement !== null && placement.warnings.length > 0;
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
    placement === null ? "clip--pre" : "",
    hasWarnings ? "clip--warn" : "",
    durationUnknown ? "clip--nodur" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Pre-sync the name reads the file's OWN start on this timeline (or says there isn't
  // one) rather than an offset from a reference that has not been chosen yet.
  const baseLabel =
    placement !== null
      ? `${name}, ${t.offsetLabel} ${placement.offset_seconds.toFixed(1)} s`
      : startUnknown
        ? `${name}, ${t.presyncStartUnknown}`
        : `${name}, ${t.presyncStart} ${formatTimecode(span.startMs)}`;

  return (
    <button
      type="button"
      className={className}
      style={{ left: `${left}px`, width: `${width}px` }}
      // A file the engine has not placed has no detail to open, and a control that does
      // nothing when pressed is worse than no control. `disabled` rather than a swapped
      // tag — see the component note.
      disabled={placement === null}
      onClick={placement !== null ? () => onSelect(placement) : undefined}
      // The identity the later "hop to the solved position" animation addresses a clip by
      // (V04-U3): the file is the one thing that is the same box before and after a sync.
      data-file={span.file}
      // The offset pattern is the §9.4 accessible name and stays exactly as it was; the
      // unknown-duration note is appended rather than replacing it.
      aria-label={durationUnknown ? `${baseLabel} — ${t.clipDurationUnknown}` : baseLabel}
      // "The playhead is inside this clip" — `aria-current="time"` is the one value in the
      // enumeration that means a temporal position, which is exactly what this is.
      aria-current={underPlayhead ? "time" : undefined}
      title={durationUnknown ? `${name} — ${t.clipDurationUnknown}` : name}
    >
      {/* v0.3 S4: the peaks canvas (or its regenerate/status affordance) fills this slot,
          behind the label. */}
      <span className="clip__waveform" data-waveform-slot="">
        <WaveformCanvas
          t={t}
          file={span.file}
          span={span}
          view={view}
          analysisStatus={analysisStatus}
        />
      </span>
      <span className="clip__name" style={{ transform: `translateX(${labelShift}px)` }}>
        {name}
      </span>
    </button>
  );
});
