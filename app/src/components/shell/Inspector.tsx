import type { ReactNode } from "react";

/**
 * The fixed 300 px right column, full height of the room (V06-R1, D-074/D-076).
 *
 * The preview panel used to be a 180 px band UNDER the timeline, which is the shape that
 * makes a still frame useless: 140×79 px of picture is a thumbnail, and the file facts and
 * the sync detail had to share one row with it. A column has the one dimension a panel of
 * facts actually needs, and taking it out of the vertical stack is what lets the timeline
 * own everything between the strip and the slot.
 *
 * It spans rows two through four on purpose — the progress band pushes the timeline down
 * and leaves this column exactly where it was.
 */
export function Inspector({ children }: { children: ReactNode }) {
  return <aside className="inspector">{children}</aside>;
}
