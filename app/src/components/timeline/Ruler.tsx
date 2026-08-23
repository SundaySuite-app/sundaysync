import { memo } from "react";
import {
  msToX,
  rulerTicks,
  tickIntervalMs,
  tickLabel,
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
 */
/** `.timeline__tick`'s own `padding-left`, and a generous advance for one character of its
 *  0.625rem tabular-numeric label. Both are estimates of what `styles.css` draws; being a
 *  few pixels pessimistic costs nothing, and being optimistic costs a clipped number. */
const TICK_PAD_PX = 4;
const TICK_CHAR_PX = 7;

export const Ruler = memo(function Ruler({
  view,
  label,
  onSeek,
}: {
  view: TimelineView;
  label: string;
  /** Given a viewport-relative x in px. */
  onSeek: (x: number) => void;
}) {
  const interval = tickIntervalMs(view, 80);
  const ticks = rulerTicks(view, 80);

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
        const label = tickLabel(ms, interval);
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
