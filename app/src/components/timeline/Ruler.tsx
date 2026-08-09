import { memo } from "react";
import { formatTimecode, msToX, rulerTicks, type TimelineView } from "../../timeline/geometry";

/**
 * The time ruler: `rulerTicks` picks a spacing that never crowds at any zoom,
 * `formatTimecode` renders each one as HH:MM:SS.mmm (milliseconds, not frames —
 * see the note in `geometry.ts`).
 *
 * Pointer-down anywhere on it seeks; dragging keeps seeking. That is the whole
 * playhead interaction in a read-mostly viewer — there is no transport here, so
 * the ruler IS the clock.
 */
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
      {ticks.map((ms) => (
        <span key={ms} className="timeline__tick" style={{ left: `${msToX(ms, view)}px` }}>
          {formatTimecode(ms)}
        </span>
      ))}
    </div>
  );
});
