import { memo } from "react";
import {
  msToX,
  rulerTicks,
  tickIntervalMs,
  tickLabel,
  TICK_CHAR_PX,
  type TimelineView,
} from "../../timeline/geometry";

/**
 * The time ruler: `rulerTicks` picks a spacing that never crowds at any zoom, and
 * `tickLabel` renders each one at the precision that spacing can actually resolve
 * (milliseconds, not frames — see the note in `geometry.ts`).
 *
 * Pointer-down anywhere on it seeks; dragging keeps seeking. That is the whole
 * playhead interaction in a read-mostly viewer — there is no transport here, so
 * the ruler IS the clock.
 *
 * Since V06-G3 (D-092 ⑧) it is sometimes literally the clock: given `originEpochMs` — the
 * moment the timeline's zero IS, which only the pre-sync layout knows — the labels are wall
 * times from the day the material was shot rather than an elapsed count from a zero the app
 * chose. The component does not decide that; it passes the epoch through to `geometry.ts`,
 * which is the one module that knows what a tick says.
 */
/** `.timeline__tick`'s own `padding-left`. The per-character advance beside it is
 *  `geometry.ts`'s `TICK_CHAR_PX`, imported rather than restated: the same number decides
 *  which spacing is admitted in the first place, and two estimates of one width is the seam
 *  where a label passes one rule and is clipped by the other. */
const TICK_PAD_PX = 4;

export const Ruler = memo(function Ruler({
  view,
  label,
  originEpochMs = null,
  onSeek,
}: {
  view: TimelineView;
  label: string;
  /** The absolute epoch of t=0, when there is one (pre-sync, D-092 ⑧). */
  originEpochMs?: number | null;
  /** Given a viewport-relative x in px. */
  onSeek: (x: number) => void;
}) {
  const interval = tickIntervalMs(view, 80, originEpochMs);
  const ticks = rulerTicks(view, 80, originEpochMs);

  function seek(e: React.PointerEvent<HTMLDivElement>) {
    onSeek(e.clientX - e.currentTarget.getBoundingClientRect().left);
  }

  return (
    <div
      className="timeline__ruler"
      aria-label={label}
      role="group"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e);
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
    >
      {ticks.map((ms) => {
        const x = msToX(ms, view);
        const label = tickLabel(ms, interval, originEpochMs);
        // The label hangs to the RIGHT of its own line, so the last tick's ran off the end
        // of the lane and was clipped mid-digit («6:00:0») by the lane's own overflow. The
        // LINE is what a ruler is for, so it stays; the number it could not finish saying
        // does not. Estimated rather than measured on purpose — a layout read here would
        // run on every pan frame, and the estimate is deliberately generous (see
        // TICK_CHAR_PX), so the only thing it can get wrong is dropping a label that would
        // just have fitted at the very edge.
        const fits = x + TICK_PAD_PX + label.length * TICK_CHAR_PX <= view.widthPx;
        return (
          <span key={ms} className="timeline__tick" style={{ left: `${x}px` }}>
            {fits ? label : null}
          </span>
        );
      })}
    </div>
  );
});
