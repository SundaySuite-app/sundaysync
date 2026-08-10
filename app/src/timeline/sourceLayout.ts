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
 *
 * Kept pure and React-free like its neighbours (`geometry.ts`, `laneLayout.ts`,
 * `viewport.ts`) — the arithmetic that is easy to get quietly wrong is the arithmetic that
 * gets unit-tested.
 */

import type { ClipSpan } from "./laneLayout";
import type { Device, ScanManifest } from "../types";

/** One device's pre-sync row: the device itself, and its files as timeline-ms spans. */
export interface SourceTrack {
  device: Device;
  /** Origin-relative ms: 0 is the earliest *known* recording time in the whole drop. */
  spans: ClipSpan[];
}

export interface SourceLayout {
  /** Devices in manifest order, minus any the override overlay emptied. */
  tracks: SourceTrack[];
  /** Files placed at 0 because nothing in them said when they started. */
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

  // The earliest KNOWN start is t=0. Files with no stamp cannot move it — otherwise a
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
