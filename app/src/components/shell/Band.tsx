import type { ReactNode } from "react";

/**
 * The 34 px progress band — the ONE drawn exception to «nothing moves» (V06-R1, D-082).
 *
 * It exists only while the app is doing something the operator is waiting for: reading the
 * sources, or running the sync. It pushes the timeline down by exactly its own height and
 * nothing else: the gutter column, the inspector column and the bottom slot are laid out by
 * the grid and do not know it is there.
 *
 * A band is not a banner. Banners are things the app has to SAY and float over the stage
 * (`.toasts`); this is a thing the app is DOING, and it takes real space for as long as it
 * is true — which is why it is a grid row and not an overlay.
 */
export function Band({ children }: { children: ReactNode }) {
  return <div className="band">{children}</div>;
}
