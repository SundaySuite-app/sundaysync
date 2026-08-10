import { memo } from "react";
import type { Strings } from "../../i18n";
import type { PrewarmStatus } from "../../state";
import { clipChrome } from "../../timeline/clipChrome";
import { formatTimecode, msToX, type TimelineView } from "../../timeline/geometry";
import { MIN_CLIP_WIDTH_PX } from "../../timeline/hop";
import type { ClipSpan } from "../../timeline/laneLayout";
import { usePlayheadInsideSpan } from "../../timeline/playhead";
import type { TimeSource } from "../../timeline/recordingTime";
import { basename } from "../../types";
import type { Placement } from "../../types";
import { ClipStatus, useClipWaveform, WaveformCanvas } from "./WaveformCanvas";

/** How much of a clip stays label-free at its right end when the chrome slides. */
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
  timeSource = null,
  offSession = false,
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
  /** Pre-sync only: which rung of the recording-time ladder positioned this file (D-067).
   *  Null after a sync, where the engine's own answer replaces every rung of it. Passed as
   *  one string rather than as the layout's map because this component is `memo`ised, and a
   *  map would be a fresh prop identity on every render of every clip. */
  timeSource?: TimeSource | null;
  /** Pre-sync only (D-071): this file carries a timestamp, from another day. */
  offSession?: boolean;
  /** Where the background pre-analysis is with this file (v0.4, D-062) — passed straight
   *  through to the waveform slot, which is the only thing that behaves differently. One
   *  file's status rather than the whole prewarm map on purpose: this component is
   *  `memo`ised, and a map would hand every clip a fresh prop on every `prewarm:file`
   *  event, re-rendering the entire timeline once per decoded file. */
  analysisStatus?: PrewarmStatus | null;
  onSelect: (placement: Placement) => void;
}) {
  const left = msToX(span.startMs, view);
  // The floor lives in `timeline/hop.ts` alongside the rest of a clip box's geometry, so a
  // fade ghost drawn from that module can never disagree with the clip it stands in for.
  const width = Math.max(MIN_CLIP_WIDTH_PX, (span.endMs - span.startMs) * view.pxPerMs);
  const name = basename(span.file);
  const hasWarnings = placement !== null && placement.warnings.length > 0;
  // Subscribed to the DERIVED boolean, so this re-renders when the playhead crosses this
  // clip's edge and not on any of the other 59 frames a second (`playhead.ts`).
  const underPlayhead = usePlayheadInsideSpan(span.startMs, span.endMs);
  // Zoomed in, a long clip starts far off the left edge — and its label would go
  // with it, leaving a row of anonymous coloured bars. Slide the label back to the
  // viewport edge instead, but never past the clip's own right end.
  //
  // V05-W1 (D-065): this is `padding-left` on the chrome row now, not a `translateX` on
  // the name. A transform slid ONE child across the box while its siblings stayed put,
  // which is how a filename ended up on top of a rebuild button; padding shrinks the flex
  // row from the left, so everything in it keeps its share of what is left.
  const labelShift = Math.max(0, Math.min(-left, width - LABEL_KEEP_PX));

  // The waveform's own state, and what it wants to say about itself. Held here rather than
  // inside the canvas component because the answer competes for pixels with the filename
  // (D-065), and the two have to be laid out by whoever can see both.
  const waveform = useClipWaveform({ t, file: span.file, span, view, analysisStatus });
  const status = waveform.status;
  const chrome = clipChrome(width, status.kind);
  // Too narrow to say it in the box: the sentence moves to the slot's tooltip, next to the
  // filename, rather than being dropped or scribbled across three pixels.
  const slotTitle =
    status.kind !== "none" && chrome.status === "none" ? `${name} — ${status.label}` : undefined;

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
  //
  // V05-W3 (D-067/D-068/D-071) adds three more marks, all of them about *where the number
  // came from* rather than about the number:
  //   - `clip--est`  — the start is an estimate, from a lower rung of the ladder. Dashed
  //     top edge, reusing the vocabulary `clip--nodur` already taught the eye.
  //   - `clip--seq`  — there is no start at all; the box is here because of its filename's
  //     place in its device's sequence (D-068).
  //   - `clip--offsession` — there IS a timestamp and it belongs to another day (D-071).
  const estimated = timeSource !== null && timeSource !== "container" && timeSource !== "none";
  const sequential = timeSource === "none";
  const className = [
    "clip",
    placement === null ? "clip--pre" : "",
    hasWarnings ? "clip--warn" : "",
    durationUnknown ? "clip--nodur" : "",
    estimated ? "clip--est" : "",
    sequential ? "clip--seq" : "",
    offSession ? "clip--offsession" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Pre-sync the name reads the file's OWN start on this timeline (or says there isn't
  // one) rather than an offset from a reference that has not been chosen yet — and, since
  // D-067, says which rung of the ladder produced it. "12:34, estimated from the file's
  // modification time" is a different claim from "12:34", and a screen reader that heard
  // only the second one would have been told a measurement.
  const sourceWords =
    timeSource === "bwf"
      ? t.presyncSourceBwf
      : timeSource === "filename"
        ? t.presyncSourceFilename
        : timeSource === "modified"
          ? t.presyncSourceModified
          : null;
  const presyncLabel = sequential
    ? `${name}, ${t.presyncSourceNone}`
    : sourceWords !== null
      ? `${name}, ${t.presyncStart} ${formatTimecode(span.startMs)} — ${t.presyncStartEstimated}: ${sourceWords}`
      : `${name}, ${t.presyncStart} ${formatTimecode(span.startMs)}`;
  const baseLabel =
    placement !== null
      ? `${name}, ${t.offsetLabel} ${placement.offset_seconds.toFixed(1)} s`
      : offSession
        ? `${presyncLabel} — ${t.presyncOffSessionClip}`
        : presyncLabel;

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
      {/* Two layers, not two independently-placed children (D-065). The canvas draws
          itself in absolute pixels and cannot be a flex item; the name and the status must
          be flex items or they overlap — as they did, in a 3 px box, on all 386 clips of a
          wedding. */}
      <WaveformCanvas waveform={waveform} title={slotTitle} />
      {chrome.name !== "none" || chrome.status !== "none" ? (
        <span className="clip__chrome" style={{ paddingLeft: `${labelShift}px` }}>
          {chrome.name !== "none" ? <span className="clip__name">{name}</span> : null}
          <ClipStatus status={status} mode={chrome.status} />
        </span>
      ) : null}
    </button>
  );
});
