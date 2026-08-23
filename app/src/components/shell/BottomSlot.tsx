import type { ReactNode } from "react";
import type { Ref } from "react";

/**
 * The 38 px bottom slot — row four of the shell (V06-R1, D-074/D-075).
 *
 * The row reads left → right: what the timeline is saying about itself, then one sentence of
 * meta, then the footnotes. Since V06-R2b (D-083) the first two of those are both
 * **portalled in** by `TimelineView` — the transport after a sync, the pre-sync legend and
 * the off-session line before one, and the meta sentence in every phase. Every one of them
 * is built from a memo of the timeline's (`audioClips` is the same memo that feeds
 * `engine.setClips`; the legend and the meta come from the ladder's counts), so lifting them
 * up to App would mean a second place deriving the same thing from the same manifest. The
 * slot offers a container and the timeline puts its own words into it — the components stay
 * where their data is, and the pixels land where the design says.
 *
 * What this file renders itself is the footnotes (`children`): the removed/skipped chips and
 * the stale notice, which are App's facts rather than the timeline's.
 *
 * It is mounted in EVERY phase, empty or not: a 38 px strip that appeared with the transport
 * would move the timeline's bottom edge in the one instant the operator is looking at a clip.
 */
export function BottomSlot({
  transportRef,
  children,
}: {
  /** Callback ref for the timeline's portal target (transport / legend / meta). */
  transportRef: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  return (
    <div className="slot">
      {/* Its own node, with no React children of its own: a portal into a container React
          is also rendering into can fight the reconciler over child order. */}
      <div className="slot__transport" ref={transportRef} />
      {children}
    </div>
  );
}
