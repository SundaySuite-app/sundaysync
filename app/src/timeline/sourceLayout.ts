/**
 * Pre-sync clip layout, from the scan manifest alone (v0.4, D-061; rewritten V05-W3).
 *
 * The timeline is the main view now, not the result view: files land on it the moment they
 * are dropped, before anything has been correlated. What positions them until then is the
 * only clock the app has without listening — and as of D-067 that is not one field but a
 * *ladder* (`recordingTime.ts`): a container `creation_time`, a BWF's split date + time, a
 * timestamp spelled into the filename, or the file's own mtime minus its duration. This
 * module takes the ladder's answer and turns it into boxes.
 *
 * Three cases, and being honest about the difference between them is the whole job:
 *
 *   - **A usable recording time** — the clip sits at its real distance from the earliest
 *     placed file in the drop. On a multi-camera shoot where every card has a roughly right
 *     clock that is already close to the answer, and the "hop" to the solved positions
 *     after a sync is small. The UI marks anything below the top rung as an estimate.
 *   - **No usable time at all** (D-068) — the file is laid out **in filename order** on its
 *     own device's row, end to end with no gap, starting where that device's last placed
 *     clip ended. This is the owner's choice, and it is a claim the app can actually make:
 *     the camera numbered the files, so their *order* is known even when their *times* are
 *     not. The previous behaviour stacked all of them at zero, where a 14-take Zoom folder
 *     drew fourteen lanes of boxes on top of each other and said only "N files have no
 *     recording time" about the pile.
 *   - **A time the session gate rejected** (D-071) — a flat battery leaves a recorder
 *     reading 2020, and a June drone folder inside a July wedding is a different shoot.
 *     Those keep their stamp (the UI names the date) but not their position, and they lay
 *     out sequentially like the untimed ones. Nothing is auto-removed: D-062's per-file
 *     removal already exists and is the operator's to use.
 *
 * Because the sequential files are laid end to end they do not overlap, so `stackClips`
 * returns **one row** for them — the 14-lane Zoom stack disappears as arithmetic rather
 * than as a special case, and a genuine two-clip overlap on one camera still stacks into
 * two lanes exactly as it did.
 *
 * Kept pure and React-free like its neighbours (`geometry.ts`, `laneLayout.ts`,
 * `viewport.ts`) — the arithmetic that is easy to get quietly wrong is the arithmetic that
 * gets unit-tested.
 */

import type { ClipSpan } from "./laneLayout";
import { sortNatural } from "./naturalSort";
import { recordingTimes, type TimeSource } from "./recordingTime";
import type { Device, ScanManifest } from "../types";

export type { TimeSource } from "./recordingTime";
export { PLAUSIBLE_SPREAD_MS } from "./recordingTime";

/** One device's pre-sync row: the device itself, and its files as timeline-ms spans. */
export interface SourceTrack {
  device: Device;
  /** Origin-relative ms: 0 is the earliest *placed* recording time in the whole drop. */
  spans: ClipSpan[];
}

export interface SourceLayout {
  /** Devices in manifest order, minus any the override overlay emptied. */
  tracks: SourceTrack[];
  /**
   * Files nothing in the drop could time, laid out in filename order (D-068).
   *
   * Since D-071 this is only the files that offered **no** evidence — the ones whose
   * evidence was rejected are in {@link outsideWindow} instead. Both are laid out the same
   * way; they are two different sentences to say about it.
   */
  unknownStart: Set<string>;
  /** Files carrying a timestamp from outside this session (D-071). Also laid out in order,
   *  but the UI names the date they claim rather than calling them untimed. */
  outsideWindow: Set<string>;
  /** The distinct days those files claim, as local-midnight ms, ascending. What the legend
   *  names — «14 filer er tidsstemplet 13.06.2023, utenfor denne økta». */
  outsideWindowDays: number[];
  /** Which rung of the ladder placed each file (D-067) — what the clip marking reads. */
  timeSource: Map<string, TimeSource>;
  /**
   * The absolute epoch of span 0 — the earliest *placed* recording time in the drop, in ms
   * since the Unix epoch. `null` when the ladder timed nothing, which is the case where the
   * spans are a filename ORDER and zero is not a moment at all (D-068).
   *
   * Returned rather than recomputed by the reader (V06-G3, D-092 ⑧): it is the number this
   * function already subtracts from every span, and the ruler's wall-clock labels are the same
   * claim as the boxes' positions. A second derivation of it upstream would be a second place
   * that can disagree about what t=0 IS — the seam that puts a clip at one time and the number
   * above it at another.
   */
  originMs: number | null;
}

/**
 * Group a scan manifest into per-device spans positioned by recording time.
 *
 * `overrides` is applied as the same view-layer overlay `SourcesPanel` uses (D-027/D-028),
 * so moving a file to another device before syncing regroups it on the timeline too — the
 * panel and the timeline are two views of one decision, and they must never disagree.
 * A device the overlay leaves empty disappears, exactly as it does in the panel; a file
 * whose effective device is not in the manifest at all is skipped rather than inventing a
 * track for it.
 *
 * Note that the *ladder* reads a file's own device (`FileEntry.device`), not its override:
 * midnight rollover is a fact about the recorder that wrote the files, and regrouping them
 * in the UI does not change which machine's clock stood still.
 */
export function sourceSpans(
  manifest: ScanManifest,
  overrides: Record<string, string>,
): SourceLayout {
  const times = recordingTimes(manifest.files);

  // The earliest PLACED start is t=0. A file the ladder could not time cannot move it —
  // otherwise a single untimed WAV would drag the whole drop's origin.
  let origin = Number.POSITIVE_INFINITY;
  for (const { startMs } of times.values()) {
    if (startMs !== null && startMs < origin) origin = startMs;
  }
  const haveOrigin = Number.isFinite(origin);

  const byId = new Map<string, SourceTrack>();
  for (const device of manifest.devices) byId.set(device.id, { device, spans: [] });

  const unknownStart = new Set<string>();
  const outsideWindow = new Set<string>();
  const outsideDays = new Set<number>();
  const timeSource = new Map<string, TimeSource>();

  /** Files with no position, per effective device — laid out after the placed ones. */
  const pending = new Map<string, { file: string; durationMs: number }[]>();

  for (const entry of manifest.files) {
    const deviceId = overrides[entry.file] ?? entry.device;
    const track = byId.get(deviceId);
    if (!track) continue;
    const time = times.get(entry.file) ?? { startMs: null, source: "none" as const };
    timeSource.set(entry.file, time.source);
    const durationMs = Math.max(0, entry.duration_seconds) * 1000;

    if (time.startMs !== null && haveOrigin) {
      const startMs = time.startMs - origin;
      track.spans.push({ file: entry.file, startMs, endMs: startMs + durationMs });
      continue;
    }

    if (time.outsideWindowMs !== undefined) {
      outsideWindow.add(entry.file);
      outsideDays.add(localMidnight(time.outsideWindowMs));
    } else {
      unknownStart.add(entry.file);
    }
    const list = pending.get(deviceId) ?? [];
    list.push({ file: entry.file, durationMs });
    pending.set(deviceId, list);
  }

  // ---- D-068: the untimed files, end to end, in the order the camera numbered them ------
  //
  // On the device's OWN row, starting where its last placed clip ended, so a card whose
  // clips were half timed and half not reads as one continuous strip rather than as a pile
  // at the start overlapping the clips that were placed. Zero gap between them: a gap would
  // be a duration nobody measured, and the only claim being made here is the order.
  for (const [deviceId, files] of pending) {
    const track = byId.get(deviceId);
    if (!track) continue;
    let cursor = 0;
    for (const span of track.spans) cursor = Math.max(cursor, span.endMs);
    const order = new Map(sortNatural(files.map((f) => f.file)).map((f, i) => [f, i]));
    const ordered = [...files].sort(
      (a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0),
    );
    for (const { file, durationMs } of ordered) {
      track.spans.push({ file, startMs: cursor, endMs: cursor + durationMs });
      cursor += durationMs;
    }
  }

  return {
    tracks: Array.from(byId.values()).filter((track) => track.spans.length > 0),
    unknownStart,
    outsideWindow,
    outsideWindowDays: [...outsideDays].sort((a, b) => a - b),
    timeSource,
    originMs: haveOrigin ? origin : null,
  };
}

/** Local midnight of an absolute ms — the *day* a rejected stamp claims, which is what the
 *  operator will recognise («the June drone folder»). Local because that is the calendar
 *  the person reading the screen is holding. */
function localMidnight(ms: number): number {
  const at = new Date(ms);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}
