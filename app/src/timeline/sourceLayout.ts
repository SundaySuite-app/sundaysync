/**
 * Pre-sync clip layout, from the scan manifest alone (v0.4, D-061).
 *
 * The timeline is the main view now, not the result view: files land on it the moment
 * they are dropped, before anything has been correlated. What positions them until then
 * is the only clock the app has without listening — the creation timestamp the camera
 * wrote into the container (`FileEntry.creation_time`, ISO-8601 UTC on MP4/MOV, absent on
 * WAV/BWF).
 *
 * That is a *provisional* placement and the UI says so (`clip--pre`, and the note the
 * caller renders when `unknownStart` is non-empty). This module's whole job is to be
 * honest about the difference between the two cases:
 *
 *   - **A parseable `creation_time`** — the clip sits at its real distance from the
 *     earliest file in the drop. On a multi-camera shoot where every card has a roughly
 *     right clock, that is already close to the answer, and the "hop" to the solved
 *     positions after a sync is small.
 *   - **No `creation_time` (or an unparseable one)** — the clip sits at zero and its file
 *     is returned in `unknownStart`. It is NOT given an invented position: a recorder that
 *     wrote no timestamp has told us nothing about when it started, and stacking those
 *     files end to end would draw an order the app does not know. They pile at the start,
 *     and the caller says why in words.
 *   - **A `creation_time` that parses but cannot be true** (V04-U5) — a flat battery leaves
 *     a camera reading 1970, and it writes that as confidently as any other date. Those are
 *     treated exactly like a missing stamp rather than being believed; see
 *     `PLAUSIBLE_SPREAD_MS` for what "cannot be true" means and why the alternative was a
 *     timeline the operator would read as broken.
 *
 * Kept pure and React-free like its neighbours (`geometry.ts`, `laneLayout.ts`,
 * `viewport.ts`) — the arithmetic that is easy to get quietly wrong is the arithmetic that
 * gets unit-tested.
 */

import type { ClipSpan } from "./laneLayout";
import type { Device, ScanManifest } from "../types";

/**
 * The widest spread of recording times this app will lay out as one drop (V04-U5).
 *
 * A stamp that parses is not the same thing as a stamp that means something. A camera
 * whose battery went flat comes back reading 1970-01-01 (or its firmware's build date),
 * writes that into every container it records, and reports it as confidently as a camera
 * with a GPS lock. Before this gate, one such file in a drop set the origin decades before
 * the rest: `contentBounds` returned a span of ~1.8 × 10¹² ms, `fitPxPerMs` clamped to
 * `MIN_PX_PER_MS`, and the operator got a timeline showing twelve hours of empty grid with
 * the dud clip at the far left and every real file fifty-six years off the right edge —
 * with nothing on screen saying why. "The app did not read my card" is exactly the wrong
 * conclusion for it to invite, and it is the one it invited.
 *
 * A day is the honest bound: SundaySync exists to line up sources that were **recording at
 * the same time**, so anything the correlator could ever match is inside one session. Two
 * files a day apart are not a shoot the engine can sync no matter what their clocks say,
 * and drawing them a day apart is not information — it is two invisible slivers.
 */
export const PLAUSIBLE_SPREAD_MS = 24 * 60 * 60 * 1000;

/**
 * The subset of `stamps` that can be read as one session, as a `[lo, hi]` bound in ms.
 *
 * The largest run of stamps that fits inside `PLAUSIBLE_SPREAD_MS`, found by a sliding
 * window over the sorted times. Ties go to the LATER window on purpose: a clock that is
 * wrong is almost always wrong *early* (an epoch, a factory date, a battery-pull default),
 * because a camera with no time to restore falls back to a fixed past, never to a fixed
 * future.
 *
 * `null` when there is nothing to bound.
 */
function plausibleWindow(stamps: number[]): [number, number] | null {
  if (stamps.length === 0) return null;
  const sorted = [...stamps].sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let bestCount = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > PLAUSIBLE_SPREAD_MS) lo++;
    const count = hi - lo + 1;
    // `>=` rather than `>`: scanning left to right, a later window of equal size replaces
    // an earlier one, which is the tie-break described above.
    if (count >= bestCount) {
      bestCount = count;
      best = [sorted[lo], sorted[hi]];
    }
  }
  return best;
}

/** One device's pre-sync row: the device itself, and its files as timeline-ms spans. */
export interface SourceTrack {
  device: Device;
  /** Origin-relative ms: 0 is the earliest *known* recording time in the whole drop. */
  spans: ClipSpan[];
}

export interface SourceLayout {
  /** Devices in manifest order, minus any the override overlay emptied. */
  tracks: SourceTrack[];
  /** Files placed at 0 because nothing usable in them said when they started — either no
   *  `creation_time` at all, or one this drop cannot read as part of the same session
   *  (`PLAUSIBLE_SPREAD_MS`). Both are the same fact to everyone downstream: the app has
   *  no honest opinion about when this file started. */
  unknownStart: Set<string>;
}

/**
 * Group a scan manifest into per-device spans positioned by creation time.
 *
 * `overrides` is applied as the same view-layer overlay `SourcesPanel` uses (D-027/D-028),
 * so moving a file to another device before syncing regroups it on the timeline too — the
 * panel and the timeline are two views of one decision, and they must never disagree.
 * A device the overlay leaves empty disappears, exactly as it does in the panel; a file
 * whose effective device is not in the manifest at all is skipped rather than inventing a
 * track for it.
 */
export function sourceSpans(
  manifest: ScanManifest,
  overrides: Record<string, string>,
): SourceLayout {
  // Parse once. `Date.parse` answers NaN for both a null-ish and a malformed stamp, and
  // `Number.isFinite` is the one check that rejects both without pretending 0 is a time.
  const startedAt = new Map<string, number>();
  for (const entry of manifest.files) {
    if (entry.creation_time === null) continue;
    const parsed = Date.parse(entry.creation_time);
    if (Number.isFinite(parsed)) startedAt.set(entry.file, parsed);
  }

  // A stamp that parses still has to be *usable* (V04-U5): one dead camera clock reading
  // 1970 would otherwise set the origin and push every real file off the right edge of a
  // maximally-zoomed-out timeline. Stamps outside the drop's plausible session window are
  // dropped here and join the no-stamp files at zero, where the UI says so in words.
  const window = plausibleWindow([...startedAt.values()]);
  if (window !== null) {
    const [lo, hi] = window;
    for (const [file, ms] of [...startedAt]) {
      if (ms < lo || ms > hi) startedAt.delete(file);
    }
  }

  // The earliest USABLE start is t=0. Files with no stamp cannot move it — otherwise a
  // single WAV would drag the whole drop's origin to the epoch.
  let origin = Number.POSITIVE_INFINITY;
  for (const ms of startedAt.values()) if (ms < origin) origin = ms;
  const haveOrigin = Number.isFinite(origin);

  const byId = new Map<string, SourceTrack>();
  for (const device of manifest.devices) byId.set(device.id, { device, spans: [] });

  const unknownStart = new Set<string>();
  for (const entry of manifest.files) {
    const track = byId.get(overrides[entry.file] ?? entry.device);
    if (!track) continue;
    const started = startedAt.get(entry.file);
    let startMs = 0;
    if (started !== undefined && haveOrigin) {
      startMs = started - origin;
    } else {
      unknownStart.add(entry.file);
    }
    track.spans.push({
      file: entry.file,
      startMs,
      endMs: startMs + entry.duration_seconds * 1000,
    });
  }

  return {
    tracks: Array.from(byId.values()).filter((track) => track.spans.length > 0),
    unknownStart,
  };
}
