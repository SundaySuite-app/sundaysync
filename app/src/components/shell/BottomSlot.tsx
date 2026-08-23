import type { ReactNode } from "react";
import type { Ref } from "react";

/**
 * The 38 px bottom slot — row four of the shell (V06-R1, D-074/D-075).
 *
 * In the result phase it carries the transport, which is **portalled in** rather than
 * rendered here: `Transport` needs `TimelineView`'s clip memos to exist at all, and moving
 * it up to App would mean rebuilding the audio schedule from a second place. So the slot
 * offers a container and the timeline puts its own transport into it — the component stays
 * where its data is, and the pixels land where the design says.
 *
 * Otherwise the slot is quiet facts. It is mounted in EVERY phase, empty or not: a 38 px
 * strip that appeared with the transport would move the timeline's bottom edge in the one
 * instant the operator is looking at a clip.
 */
export function BottomSlot({
  transportRef,
  children,
}: {
  /** Callback ref for the portal target. */
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
