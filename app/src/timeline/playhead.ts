// Adapted from SundayEdit (same owner) — src/features/timeline/playhead.ts; see docs/DECISIONS.md D-051.

/**
 * Shared playhead position — a tiny external store bridging the interactive
 * timeline's scrub/seek clock to consumers rendered outside its component
 * tree (e.g. a clip detail dialog that wants to know whether the playhead is
 * currently inside it). Lifting the clock into top-level React state instead
 * would re-render the whole view on every animation frame; this keeps 60 fps
 * churn scoped to the components that actually subscribe.
 */

import { useSyncExternalStore } from "react";

let playheadMs = 0;
const listeners = new Set<() => void>();

/** Publish the current playhead (the timeline view calls this whenever it moves). */
export function publishPlayheadMs(ms: number): void {
  if (ms === playheadMs) return;
  playheadMs = ms;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => playheadMs;

/** The live playhead, ms. Re-renders the subscriber on every change. */
export function usePlayheadMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** One-shot read (event handlers) — no subscription, no re-renders. */
export function getPlayheadMs(): number {
  return playheadMs;
}

/**
 * Whether the playhead stands strictly inside (startMs, endMs). Subscribing
 * to the DERIVED boolean instead of the raw ms means the consumer re-renders
 * only when the answer flips — not 60×/s during playback (useSyncExternalStore
 * bails out while consecutive snapshots are Object.is-equal).
 */
export function usePlayheadInsideSpan(startMs: number, endMs: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () => playheadMs > startMs && playheadMs < endMs,
  );
}
