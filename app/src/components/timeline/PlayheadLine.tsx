import { msToX, type TimelineView } from "../../timeline/geometry";
import { usePlayheadMs } from "../../timeline/playhead";

/**
 * The vertical line marking the playhead, drawn over every track at once.
 *
 * This is the only component that subscribes to the playhead store, which is the
 * entire point of that store existing (see `timeline/playhead.ts`): scrubbing the
 * ruler moves the line without re-rendering the tracks, the clips, or the
 * dialog. The line itself moves by `transform`, so a drag is a compositor job
 * rather than a layout one.
 */
export function PlayheadLine({ view }: { view: TimelineView }) {
  const playheadMs = usePlayheadMs();
  const x = msToX(playheadMs, view);

  return (
    <div className="timeline__playhead" aria-hidden="true">
      <div className="timeline__playhead-line" style={{ transform: `translateX(${x}px)` }} />
    </div>
  );
}
