import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { PlacedClip } from "../../audio/schedulePlan";
import { getPlaybackEngine } from "../../audio/scheduler";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import {
  visibleRange,
  xToMs,
  zoomAround,
  type TimelineView as View,
} from "../../timeline/geometry";
import { LANE_HEIGHT_PX } from "../../timeline/hop";
import { stackClips, type ClipSpan } from "../../timeline/laneLayout";
import { getPlayheadMs, publishPlayheadMs } from "../../timeline/playhead";
import { type TimeSource } from "../../timeline/recordingTime";
import { sourceSpans } from "../../timeline/sourceLayout";
import {
  clampScroll,
  contentBounds,
  fitPxPerMs,
  scrollbarFracToScrollMs,
  scrollbarMetrics,
  scrollbarValueNow,
  thumbOffsetFracToScrollMs,
} from "../../timeline/viewport";
import type { PrewarmStatus } from "../../state";
import type { Device, Placement, ScanManifest, SyncOutcome, Warning } from "../../types";
import { usePopoverDismiss } from "../shell/usePopoverDismiss";
import { PlayheadLine } from "./PlayheadLine";
import { Ruler } from "./Ruler";
import { Track } from "./Track";
import { Transport } from "./Transport";
import { useHop } from "./useHop";
import { warningText } from "./warnings";

/**
 * The timeline — the main view (v0.4, D-061), not just §9.4's result view (v0.3, D-051).
 *
 * One component, mounted from the moment there is a manifest and never torn down again:
 * `sources` draws the dropped files where their own creation timestamps say they belong,
 * `syncing` keeps exactly those boxes on screen (dimmed, inert) while the engine works,
 * and `result` swaps in the solved placements. Same component, same DOM nodes, same clip
 * identities (`data-file`) throughout — which is the structural precondition for the later
 * stage that animates each clip HOPPING from its metadata guess to where the audio says it
 * actually was. A view that unmounted between phases could only cut.
 *
 * What is result-only is what genuinely does not exist before a sync: the transport and
 * the playhead (there is no schedule to play), the sequence meta, the unsynced shelf, the
 * per-device mute/solo, and the SYNC HALF of the preview panel. What works in every phase
 * is everything about *looking*: ruler, zoom, pan, scrollbar, virtualization — and, since
 * D-070, marking a clip and reading its picture and its file facts in the panel below.
 *
 * The old view laid clips out in percent of the widest span, which meant a
 * 4-second offset inside a 90-minute service was a sub-pixel sliver nobody could
 * see, let alone judge. This one has a zoom: time↔pixel mapping comes from
 * `timeline/geometry.ts`, so the operator can fit the whole day on screen and
 * then wind in until the millisecond the engine is claiming is visible as a
 * millisecond.
 *
 * Still informational, not an editor (§9): clips do not drag. What is
 * interactive is *looking* — pan, zoom, scrub the playhead, open a clip.
 *
 * Two boundaries live here and nowhere else:
 *   1. **Seconds → milliseconds.** The `SyncResult` contract is in seconds
 *      (`offset_seconds`, `durations`); every timeline module below is in ms.
 *      The conversion happens once, in the memo, so no component downstream can
 *      get the unit wrong.
 *   2. **Origin.** `contentBounds` decides where t=0 sits (see its comment).
 *      Clip boxes are drawn at timeline-local ms; a clip's accessible name and
 *      the preview panel keep showing the engine's real `offset_seconds`.
 */

/** Wheel/button zoom step. Small enough that a trackpad flick is not a jump. */
const WHEEL_FACTOR = 1.15;
const BUTTON_FACTOR = 1.4;

/** Arrow-key playhead nudge, and its shift-held coarse step (V03-S6). */
const NUDGE_MS = 1000;
const NUDGE_COARSE_MS = 10_000;

/** Arrow-key scrollbar step, as a fraction of the visible window — the "line" of a
 *  horizontal scrollbar (finding 14). */
const SCROLL_STEP_FRACTION = 0.1;

const VIEWPORT_ID = "timeline-viewport";

const NO_FILES: ReadonlySet<string> = new Set();
/** No file has a pre-sync time source — the result phase, where the engine answered. */
const NO_SOURCES: ReadonlyMap<string, TimeSource> = new Map();
const NO_DAYS: readonly number[] = [];

/** Which of the app's phases this timeline is drawing. */
export type TimelinePhase = "sources" | "syncing" | "result";

/** Everything the tracks are drawn from, whichever phase produced it. */
interface TimelineContent {
  tracks: { device: Device; rows: ClipSpan[][] }[];
  /** How many clips are drawn in total. Only used to tell "some files have no usable
   *  recording time" from "NONE of them do", which are two different sentences. */
  clipCount: number;
  contentSpanMs: number;
  /** Null before a sync: there are spans, but no engine placements behind them. */
  placements: Map<string, Placement> | null;
  audioClips: PlacedClip[];
  unknownDurations: ReadonlySet<string>;
  /** Pre-sync only (D-067): which rung of the recording-time ladder positioned each file.
   *  This is what the legend above the frame is counted from, and what marks a clip as an
   *  estimate rather than as a measurement. */
  timeSource: ReadonlyMap<string, TimeSource>;
  /** Pre-sync only (D-071): files stamped outside this session — named, never removed. */
  outsideWindow: ReadonlySet<string>;
  /** The distinct days those files claim, as local-midnight ms. The legend names them. */
  outsideWindowDays: readonly number[];
  /** Device carrying the reference badge — the engine's pick, or the operator's. */
  referenceDevice: string | null;
}

/** Nothing to draw — no manifest yet. Frozen so it is never a fresh identity per render. */
const EMPTY_CONTENT: TimelineContent = {
  tracks: [],
  clipCount: 0,
  contentSpanMs: 1,
  placements: null,
  audioClips: [],
  unknownDurations: NO_FILES,
  timeSource: NO_SOURCES,
  outsideWindow: NO_FILES,
  outsideWindowDays: NO_DAYS,
  referenceDevice: null,
};

export function TimelineView({
  t,
  phase,
  manifest,
  overrides,
  reference,
  excluded,
  prewarm,
  outcome,
  stale,
  selected,
  onSelect,
  slotEl,
  stripStatusEl,
  onHopSettled,
}: {
  t: Strings;
  phase: TimelinePhase;
  /** The scan — what the pre-sync layout is drawn from. */
  manifest: ScanManifest | null;
  /** file → device, the same overlay the sources panel groups by (D-027/D-028). */
  overrides: Record<string, string>;
  /** The operator's chosen reference file, pre-sync — null means "let the engine pick". */
  reference: string | null;
  /** Files taken out of the run (v0.4, D-062). Filtered out of the drawn spans in BOTH
   *  phases: the panel and the timeline are two views of one decision, and a clip still
   *  on screen for a file the next run will skip is the loudest possible way to disagree. */
  excluded: ReadonlySet<string>;
  /** file -> background pre-analysis status (v0.4, D-062), passed through to the clips. */
  prewarm: Record<string, PrewarmStatus>;
  /** Null until a sync has produced one. */
  outcome: SyncOutcome | null;
  stale: boolean;
  /**
   * The marked clip, as a FILE PATH — owned by App since V06-R1 (D-075).
   *
   * It used to live here, which was right while the panel it fed lived here too. The
   * inspector is a column of the room now, outside this component entirely, and a selection
   * held below the thing that renders it cannot be read by it. What did NOT move is the rule
   * the selection has to obey (see the pruning effect below): only this component knows
   * which files are actually drawn, so only it can say when a selection has stopped naming
   * one — it reports that upwards rather than fixing it locally.
   */
  selected: string | null;
  onSelect: (file: string | null) => void;
  /**
   * Where the transport belongs on screen: the bottom slot's own node (D-075). `Transport`
   * stays rendered by this component because it needs `audioClips` — the memo that feeds the
   * audio schedule — and is PORTALLED into the slot, so the component sits where its data is
   * and the pixels land where the design says. Null before App's callback ref has run.
   */
  slotEl: HTMLElement | null;
  /**
   * Where the result's warnings belong on screen: a `<span>` App renders inside the strip's
   * sources cluster, after the problem chip (V06-R2b, D-083). Same bargain as `slotEl` — the
   * warnings are `outcome`'s, and `outcome` is this component's prop, so the chip is rendered
   * here and portalled there rather than App growing a second reader of the same field.
   */
  stripStatusEl: HTMLElement | null;
  /** The hop has come to rest (D-082) — App holds the progress band open until it has. */
  onHopSettled?: () => void;
}) {
  const result = outcome?.result ?? null;

  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  // ---- Content: seconds → ms, grouped per device, stacked into sub-tracks ----
  //
  // Two sources, one shape. With an outcome, the §5 contract's `offset_seconds` are the
  // truth. Without one, `sourceSpans` positions the same files by their own creation
  // timestamps — provisional, and marked as such downstream. Everything below these memos
  // (zoom, pan, virtualization, the ruler) works on the shape, not on where it came from.
  //
  // Deliberately TWO memos, not one with the union of their dependencies. The outcome's
  // content must not be rebuilt because `overrides` changed: an override on a result marks
  // it stale, and rebuilding `audioClips` there would hand `Transport` a fresh array,
  // which re-enters `engine.setClips` and rebuilds the audio schedule underneath whatever
  // is currently playing.
  const outcomeContent: TimelineContent | null = useMemo(() => {
    if (!outcome) return null;
    const { result, durations } = outcome;
    // D-062: a file removed AFTER a sync leaves the picture at once. The result is marked
    // stale by the same action, so what is on screen is a run that no longer matches the
    // sources — but it must at least match the sources the operator can see. `excluded` is
    // therefore a real dependency of this memo, unlike `overrides` (see the note above):
    // a removed clip has to leave `audioClips` too, or playback would keep sounding a file
    // that is no longer on the timeline.
    const placed = result.placements.filter((p) => !excluded.has(p.file));
    const placements = new Map<string, Placement>();
    for (const p of placed) placements.set(p.file, p);

    // A placement with no `durations` entry is a hole in the outcome, not a zero-length
    // clip — the probe failed to report a duration, or the two halves of the outcome
    // disagree about which files exist. Drawn as a 3 px sliver and otherwise unremarked, it
    // reads as "this camera recorded nothing", which is a lie the operator would act on
    // (finding 15). So the set is carried down to the clips, which say so.
    const unknownDurations = new Set<string>(
      placed.filter((p) => durations[p.file] === undefined).map((p) => p.file),
    );

    const spans: ClipSpan[] = placed.map((p) => {
      const startMs = p.offset_seconds * 1000;
      return { file: p.file, startMs, endMs: startMs + (durations[p.file] ?? 0) * 1000 };
    });
    const { originMs, spanMs } = contentBounds(spans);

    const byDevice = new Map<string, ClipSpan[]>();
    for (const span of spans) {
      const device = placements.get(span.file)?.device;
      if (device === undefined) continue;
      const list = byDevice.get(device) ?? [];
      list.push({ ...span, startMs: span.startMs - originMs, endMs: span.endMs - originMs });
      byDevice.set(device, list);
    }

    // `result.devices` order is preserved, and a device with no placements keeps
    // its (empty) track — §7.5.
    const tracks = result.devices.map((device) => ({
      device,
      rows: stackClips(byDevice.get(device.id) ?? []),
    }));

    // What playback plays (D-055). Deliberately built from the SAME origin the boxes are
    // drawn at: if the audio used a different zero, the playhead would be pointing at one
    // clip while the ears heard another, and every judgement made here would be wrong.
    // Drift correction is applied downstream, in `clipTransport`, so this stays the raw
    // §5 placement — the thing the timeline draws.
    const audioClips: PlacedClip[] = placed.map((p) => ({
      file: p.file,
      device: p.device,
      startSec: (p.offset_seconds * 1000 - originMs) / 1000,
      durationSec: durations[p.file] ?? 0,
      driftPpm: p.drift_ppm,
      projectedEndErrorMs: p.projected_end_error_ms,
    }));

    return {
      tracks,
      clipCount: spans.length,
      contentSpanMs: spanMs,
      placements,
      audioClips,
      unknownDurations,
      timeSource: NO_SOURCES,
      outsideWindow: NO_FILES,
      outsideWindowDays: NO_DAYS,
      referenceDevice: result.reference?.device ?? null,
    };
  }, [outcome, excluded]);

  const sourceContent: TimelineContent | null = useMemo(() => {
    // Only the phase that has no outcome pays for this.
    if (outcome || !manifest) return null;
    const layout = sourceSpans(
      // D-062: the removed files never reach the layout, so they cannot influence the
      // origin either — a lens-cap take with the earliest timestamp used to anchor t=0 for
      // the whole drop, and removing it should move the picture, not just delete a box.
      excluded.size === 0
        ? manifest
        : { ...manifest, files: manifest.files.filter((f) => !excluded.has(f.file)) },
      overrides,
    );
    const { originMs, spanMs } = contentBounds(layout.tracks.flatMap((s) => s.spans));
    const tracks = layout.tracks.map(({ device, spans }) => ({
      device,
      rows: stackClips(
        spans.map((s) => ({ ...s, startMs: s.startMs - originMs, endMs: s.endMs - originMs })),
      ),
    }));
    // Pre-sync the reference is whatever the operator starred, under the same override
    // overlay the grouping uses — so the badge follows a file that has been moved.
    const referenceDevice =
      reference === null
        ? null
        : (overrides[reference] ??
          manifest.files.find((f) => f.file === reference)?.device ??
          null);
    return {
      tracks,
      clipCount: layout.tracks.reduce((n, t) => n + t.spans.length, 0),
      contentSpanMs: spanMs,
      placements: null,
      audioClips: [],
      unknownDurations: NO_FILES,
      timeSource: layout.timeSource,
      outsideWindow: layout.outsideWindow,
      outsideWindowDays: layout.outsideWindowDays,
      referenceDevice,
    };
  }, [outcome, manifest, overrides, reference, excluded]);

  const {
    tracks,
    clipCount,
    contentSpanMs,
    placements,
    audioClips,
    unknownDurations,
    timeSource,
    outsideWindow,
    outsideWindowDays,
    referenceDevice,
  }: TimelineContent = outcomeContent ?? sourceContent ?? EMPTY_CONTENT;

  // ---- What the legend above the frame says (D-067/D-068/D-071) ----------------------
  //
  // Four counts, four different claims, and they sum to every clip on screen — §7.3's rule
  // that every input is accounted for, applied to the sentence the operator reads. Derived
  // here rather than returned by `sourceSpans` because it is presentation: the layout's job
  // is where the boxes go, and a count is not a position.
  const legend = useMemo(() => {
    let placed = 0;
    let estimated = 0;
    let ordered = 0;
    for (const [file, source] of timeSource) {
      if (outsideWindow.has(file)) continue;
      if (source === "container") placed += 1;
      else if (source === "none") ordered += 1;
      else estimated += 1;
    }
    return { placed, estimated, ordered, offSession: outsideWindow.size };
  }, [timeSource, outsideWindow]);

  // ---- View state: zoom + pan, measured against the lane column's width ----
  const [view, setView] = useState<View>(() => ({
    pxPerMs: fitPxPerMs(contentSpanMs, 900),
    scrollMs: 0,
    widthPx: 900,
  }));

  const clampS = useCallback(
    (scrollMs: number, pxPerMs: number, widthPx: number) =>
      clampScroll(scrollMs, pxPerMs, widthPx, contentSpanMs),
    [contentSpanMs],
  );

  const fittedSpan = useRef<number | null>(null);

  // The hop (v0.4, D-063). Declared ABOVE the measure effect on purpose: React runs a
  // component's layout effects in declaration order, and `hop.frozen` has to be set on the
  // outcome's own commit before the fit below reads it.
  const hop = useHop({
    tracks,
    view,
    outcome,
    contentSpanMs,
    bodyRef,
    sectionRef,
    ghostRef,
    setView,
    fittedSpan,
    onSettled: onHopSettled,
  });

  // Measure the lane column and fit the content into it. The fit re-runs whenever
  // the content changes (a new sync outcome) — but NOT on every resize, or the
  // user's chosen zoom would be thrown away by an incidental window drag.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setView((v) => {
        const widthPx = w > 0 ? w : v.widthPx;
        // Mid-hop the result is deliberately drawn under the PRE-SYNC view, and the hop
        // owns the view until it hands it back (D-063). Not even the clamp may run here:
        // the result's span is usually shorter than the pre-sync one, so clamping would
        // yank the scroll to a new maximum in the very frame the clips start moving, and
        // every delta they were given would be measured from somewhere they no longer are.
        if (hop.frozen.current) return { ...v, widthPx };
        if (fittedSpan.current !== contentSpanMs) {
          fittedSpan.current = contentSpanMs;
          return { widthPx, pxPerMs: fitPxPerMs(contentSpanMs, widthPx), scrollMs: 0 };
        }
        return { ...v, widthPx, scrollMs: clampS(v.scrollMs, v.pxPerMs, widthPx) };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentSpanMs, clampS, hop.frozen]);

  // A fresh result is a fresh clock: the old playhead pointed into a timeline
  // that no longer exists.
  useEffect(() => {
    publishPlayheadMs(0);
  }, [result]);

  // ---- The selection must name something that is on screen (V05-W4b, D-070) -----------
  //
  // Generalised from `useEffect(() => { if (!result) setSelected(null) }, [result])`, which
  // was the same rule in the one form the old selection could express: the detail dialog
  // was result-only, so losing the result was the only way its subject could vanish. A file
  // path can go stale in four ways — the operator removed the file (D-062), excluded it, a
  // re-scan came back without it, or the outcome it was placed by was pulled — and all four
  // are one question: is the marked file still drawn? A panel describing a clip that is no
  // longer anywhere on the timeline is the same lie the dialog would have been.
  const drawnFiles = useMemo(() => {
    const files = new Set<string>();
    for (const { rows } of tracks) for (const row of rows) for (const span of row) files.add(span.file);
    return files;
  }, [tracks]);
  useEffect(() => {
    if (selected !== null && !drawnFiles.has(selected)) onSelect(null);
  }, [drawnFiles, selected, onSelect]);

  // (The derivations the preview panel needs — the placement, the manifest entry and the
  // recording-time ladder — moved to App with the panel itself in V06-R1 (D-075). They were
  // never about the timeline: they are three different views of ONE file, and the component
  // that renders that file's column is the one that should compute them.)

  // ---- Playback (v0.3, D-055) ----
  const engine = getPlaybackEngine();
  const playback = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  // `"25/1"` → 25. The exporter's half-frame gate needs it so playback corrects exactly
  // the clips the export will; an unparseable or mixed rate simply skips that gate.
  const fps = useMemo(() => {
    if (!result) return undefined;
    const [num, den] = result.sequence.fps.split("/").map(Number);
    return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : undefined;
  }, [result]);

  /**
   * The one sentence the slot's middle carries (V06-R2b, D-083). After a sync it is the
   * sequence the exporter will write; before one it is what the positions on screen ARE.
   *
   * "Provisional positions from the files' own timestamps" is a claim, and it is false when
   * not one file in the drop reached ANY rung of the ladder — a folder of untagged WAVs, or a
   * set of cards whose clocks were all rejected (`recordingTime.ts`). Then nothing was
   * positioned by a clock at all; the clips are in filename order (D-068), and saying
   * otherwise invites the operator to read that order as a claim about when they recorded
   * (V04-U5).
   */
  const metaSentence = result
    ? t.sequenceMeta(result.sequence.fps, formatDuration(result.sequence.duration_seconds))
    : clipCount > 0 && legend.placed + legend.estimated === 0
      ? t.presyncMetaNoClock
      : t.presyncMeta;

  /** What the engine wants to say about the run as a whole — the strip's chip (D-083). */
  const warnings: readonly Warning[] = result?.warnings ?? [];

  // (The unsynced shelf moved into the strip's problem popover in V06-R2a (D-079). It was
  // never about the timeline — an unplaced clip has no position, so it has no x coordinate —
  // and in a room whose timeline fills the stage there is no row under it to put a red box in.
  // App owns the list and the two callbacks now; `excluded` is still read here, by the spans.)

  const toggleMute = useCallback((id: string) => engine.toggleMute(id), [engine]);
  const toggleSolo = useCallback((id: string) => engine.toggleSolo(id), [engine]);
  const showSolo = (result?.devices.length ?? 0) > 1;

  // Every gesture that takes the view calls `hop.cancel()` first (D-063): a hop describes
  // a journey between two positions on a stationary canvas, and the moment the operator
  // moves the canvas the journey stops describing anything. Cancelling drops the clips on
  // their true positions and leaves the view exactly where it was put.
  const zoomBy = useCallback(
    (factor: number, anchorX?: number) => {
      hop.cancel();
      setView((v) => {
        const z = zoomAround(v, factor, anchorX ?? v.widthPx / 2);
        return { ...z, scrollMs: clampS(z.scrollMs, z.pxPerMs, v.widthPx) };
      });
    },
    [clampS, hop],
  );

  const fit = useCallback(() => {
    hop.cancel();
    setView((v) => ({
      ...v,
      pxPerMs: fitPxPerMs(contentSpanMs, v.widthPx),
      scrollMs: 0,
    }));
  }, [contentSpanMs, hop]);

  // Wheel is bound natively, not through React's synthetic handler, because React
  // registers `wheel` on the root as PASSIVE — `preventDefault()` there is a no-op,
  // and without it a ctrl+wheel zoom becomes a browser page zoom and a pan scrolls
  // the whole window. That binding is load-bearing; do not move it to `onWheel`.
  //
  // What is NOT load-bearing is calling `preventDefault()` unconditionally, which is what
  // this used to do (finding 13). The timeline is tall, and the export bar and the unsynced
  // shelf live below it, so a plain downward wheel over the timeline was the natural way to
  // reach them — and it did nothing at all, because every wheel event was swallowed and
  // turned into a horizontal pan. Now the gesture decides:
  //
  //   ctrl/meta         → zoom (prevented; otherwise the browser page-zooms)
  //   deltaX, or shift  → pan  (prevented; otherwise the window scrolls sideways)
  //   plain vertical    → not ours. Let it bubble and scroll the page.
  //
  // Shift+wheel is the horizontal-scroll convention every OS already applies to a mouse
  // with only a vertical wheel; trackpads send a real `deltaX` and need no modifier.
  useEffect(() => {
    const el = bodyRef.current;
    const viewport = viewportRef.current;
    if (!el || !viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchorX = e.clientX - viewport.getBoundingClientRect().left;
        zoomBy(e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR, anchorX);
        return;
      }
      const horizontal = e.deltaX !== 0 || e.shiftKey;
      if (!horizontal) return;
      e.preventDefault();
      hop.cancel();
      const delta = e.deltaX || e.deltaY;
      setView((v) => ({
        ...v,
        scrollMs: clampS(v.scrollMs + delta / v.pxPerMs, v.pxPerMs, v.widthPx),
      }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, clampS, hop]);

  // ---- Background drag = pan ----
  const pan = useRef<{ x: number; scrollMs: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Controls and the ruler own their own pointer gestures.
    //
    // V05-W4b (D-070) changed what this covers without changing a character of it: a
    // pre-sync clip used to be a DISABLED button, and a disabled control receives no
    // pointer events at all — the press landed on the lane behind it and started a pan.
    // Now every clip is enabled, so a press on a clip is a press on a `button` and never
    // pans. That is correct (the clip is a control now, in both phases) and it is a real
    // behaviour change on a dense timeline, where the clips cover most of the lane. If it
    // turns out to hurt, the answer is a drag threshold ON THE CLIP — press-and-move more
    // than a few pixels pans, a clean click selects — not making the clip inert again.
    const target = e.target as HTMLElement;
    if (target.closest("button, select, label, .timeline__ruler")) return;
    hop.cancel();
    pan.current = { x: e.clientX, scrollMs: view.scrollMs };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = pan.current;
    if (!start) return;
    setView((v) => ({
      ...v,
      scrollMs: clampS(start.scrollMs - (e.clientX - start.x) / v.pxPerMs, v.pxPerMs, v.widthPx),
    }));
  }

  function endPan(e: React.PointerEvent<HTMLDivElement>) {
    if (!pan.current) return;
    pan.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  // ---- Scrollbar ----
  const bar = scrollbarMetrics(view, contentSpanMs);

  /**
   * Where inside the thumb the pointer went down, as a fraction of the trough — `null`
   * while no drag is in progress.
   *
   * The whole of finding 5. `offsetFrac` is the thumb's LEFT EDGE, but the same handler
   * ran for a press on the thumb and a press on empty trough, and it treated the pointer
   * as the CENTRE of the wanted window. Measured: grabbing the thumb's left edge jumped
   * half a window backwards before the drag had moved a pixel; the right edge, half a
   * window forwards. Remembering the grab offset and mapping from `frac - grabΔ` through
   * `thumbOffsetFracToScrollMs` (the exact inverse of `scrollbarMetrics`) makes the thumb
   * stay under the finger, which is the only behaviour a scrollbar is allowed to have.
   */
  const grabDelta = useRef<number | null>(null);

  function troughFrac(e: React.PointerEvent<HTMLDivElement>): number | null {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return (e.clientX - rect.left) / rect.width;
  }

  function onScrollbarDown(e: React.PointerEvent<HTMLDivElement>) {
    const frac = troughFrac(e);
    if (frac === null) return;
    hop.cancel();
    e.currentTarget.setPointerCapture(e.pointerId);

    if (frac >= bar.offsetFrac && frac <= bar.offsetFrac + bar.thumbFrac) {
      // On the thumb: pick it up where it was touched and change nothing yet.
      grabDelta.current = frac - bar.offsetFrac;
      return;
    }
    // Empty trough: jump so the window centres on the press — the click-to-jump that
    // lands where the eye expects. From then on the drag behaves as if the thumb had been
    // grabbed by its middle, which is where it now is.
    grabDelta.current = bar.thumbFrac / 2;
    setView((v) => ({ ...v, scrollMs: scrollbarFracToScrollMs(frac, v, contentSpanMs) }));
  }

  function onScrollbarMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const grab = grabDelta.current;
    if (grab === null) return;
    const frac = troughFrac(e);
    if (frac === null) return;
    setView((v) => ({
      ...v,
      scrollMs: thumbOffsetFracToScrollMs(frac - grab, v, contentSpanMs),
    }));
  }

  function onScrollbarUp(e: React.PointerEvent<HTMLDivElement>) {
    grabDelta.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  /** Arrow/Home/End on the focused scrollbar (finding 14). Reuses `clampScroll` so a
   *  keyboard user cannot reach a scroll a pointer could not. */
  function onScrollbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    hop.cancel();
    setView((v) => {
      const visibleMs = v.widthPx / v.pxPerMs;
      const step = visibleMs * SCROLL_STEP_FRACTION;
      let next: number;
      switch (e.key) {
        case "ArrowLeft":
          next = v.scrollMs - step;
          break;
        case "ArrowRight":
          next = v.scrollMs + step;
          break;
        case "PageUp":
          next = v.scrollMs - visibleMs;
          break;
        case "PageDown":
          next = v.scrollMs + visibleMs;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = contentSpanMs;
          break;
        default:
          return v;
      }
      return { ...v, scrollMs: clampS(next, v.pxPerMs, v.widthPx) };
    });
    if (
      ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(e.key)
    ) {
      e.preventDefault();
      // The section's own handler maps Home and the arrows to the PLAYHEAD. While the
      // scrollbar has focus they belong to the scrollbar.
      e.stopPropagation();
    }
  }

  const [visStart, visEnd] = visibleRange(view);
  // Seeking goes through the engine rather than straight to `publishPlayheadMs`: while
  // playing, moving the playhead has to rebuild the audio schedule too, and the engine is
  // the only thing that knows whether it is playing.
  const seekMs = useCallback(
    (ms: number) => engine.seekTo(Math.min(Math.max(0, ms), contentSpanMs) / 1000),
    [engine, contentSpanMs],
  );
  const seek = useCallback((x: number) => seekMs(xToMs(x, view)), [seekMs, view]);

  // ---- Keyboard ----
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Anything the user is typing into, or dragging with the arrow keys, owns its own
    // keys: the project-name field (outside this section), the volume slider and the
    // device `<select>`s inside it. Without this, adjusting the volume with the arrow keys
    // would also drag the playhead, and Space in a text field would start playback.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "+" || e.key === "=") zoomBy(BUTTON_FACTOR);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / BUTTON_FACTOR);
    // `0` and `F` both fit — `0` because it is what every NLE uses, `F` because it is what
    // this app's own button is labelled.
    else if (e.key === "0" || e.key === "f" || e.key === "F") fit();
    // The playhead, in whole seconds: fine enough to walk up to a transient, coarse enough
    // that crossing a service takes a held key rather than an afternoon. Shift is the
    // ten-second stride.
    else if (e.key === "ArrowLeft")
      seekMs(getPlayheadMs() - (e.shiftKey ? NUDGE_COARSE_MS : NUDGE_MS));
    else if (e.key === "ArrowRight")
      seekMs(getPlayheadMs() + (e.shiftKey ? NUDGE_COARSE_MS : NUDGE_MS));
    else if (e.key === "Home") seekMs(0);
    else if (e.key === "End") seekMs(contentSpanMs);
    // Space is play/pause everywhere that has a transport (D-055). It is checked last so
    // it cannot interfere with the existing +/−/0 zoom keys, and `preventDefault` below
    // stops the browser scrolling the page — which is what Space would otherwise do, and
    // would look like the timeline jumping.
    else if (e.key === " ") void engine.toggle(getPlayheadMs() / 1000);
    else return;
    e.preventDefault();
  }

  return (
    <section
      ref={sectionRef}
      className={[
        "result timeline",
        stale ? "result--stale" : "",
        // Dimmed and inert while the engine runs: the boxes stay on screen (that is the
        // point) but nothing here is a decision the operator can still change mid-run.
        phase === "syncing" ? "timeline--busy" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={t.timelineAria}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="timeline__frame">
        {/* The vertical safety net (V05-W3). Twelve devices at two lanes each is some 800 px
            of tracks, and this frame had `overflow: hidden` and no height — so the BODY grew
            instead, pushing the sources panel and the sync button off a laptop screen. The
            tracks scroll inside their own box now, with the ruler stuck to its top so the
            times stay readable at any scroll offset, and the horizontal scrollbar row left
            outside it (it is a sibling already, and a scrollbar that scrolled away would be
            a control the operator has to hunt for). */}
        <div className="timeline__scroll">
          <div
            className="timeline__body"
            ref={bodyRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div className="track track--ruler">
              {/* The zoom lives in the ruler row's gutter cell (V06-R2b, D-083) — the one
                  cell in the whole frame that was empty, directly above the column the
                  buttons are about, and on the row that already says what the horizontal
                  axis means. It used to sit on a line above the frame, which is a line the
                  room no longer has. Same three accessible names, so the muscle memory and
                  the specs that click by name both survive. */}
              <div className="track__gutter">
                <div className="timeline__zoom">
                  <button type="button" className="ghost" onClick={() => zoomBy(1 / BUTTON_FACTOR)} aria-label={t.zoomOut}>
                    −
                  </button>
                  <button type="button" className="ghost" onClick={() => zoomBy(BUTTON_FACTOR)} aria-label={t.zoomIn}>
                    +
                  </button>
                  <button type="button" className="ghost" onClick={fit} aria-label={t.zoomFitAria}>
                    {t.zoomFit}
                  </button>
                </div>
              </div>
              <div className="track__lanes" id={VIEWPORT_ID} ref={viewportRef}>
                <Ruler view={view} label={t.rulerAria} onSeek={seek} />
              </div>
            </div>

            {tracks.map(({ device, rows }) => (
              <Track
                key={device.id}
                t={t}
                device={device}
                rows={rows}
                placements={placements}
                view={view}
                visStart={visStart}
                visEnd={visEnd}
                isReference={referenceDevice === device.id}
                unknownDurations={unknownDurations}
                timeSource={timeSource}
                outsideWindow={outsideWindow}
                prewarm={prewarm}
                laneHeight={LANE_HEIGHT_PX}
                onSelect={onSelect}
                muted={playback.muted.includes(device.id)}
                soloed={playback.soloed.includes(device.id)}
                showSolo={showSolo}
                showMix={result !== null}
                onToggleMute={toggleMute}
                onToggleSolo={toggleSolo}
              />
            ))}

            {/* Where a departing clip's fade ghost is drawn (v0.4, D-063). React has already
                removed the real node by the time anything can react to the outcome, so the
                thing that fades is a copy placed at the box the clip used to occupy. Offset
                from the top by the ruler and from the left by the gutter, so it shares the
                lane column's origin — the same origin `timeline/hop.ts` measures in.
                Populated imperatively and only during a hop; empty the rest of the time. */}
            <div className="timeline__ghosts" ref={ghostRef} aria-hidden="true" />

            {/* The playhead is the transport's marker; before a sync there is nothing to
                play and no schedule for it to point into. */}
            {result && (
              <div className="timeline__overlay">
                <PlayheadLine view={view} />
              </div>
            )}
          </div>
        </div>

        <div className="track track--scrollbar">
          <div className="track__gutter" />
          <div className="track__lanes">
            <div
              className="timeline__scrollbar"
              role="scrollbar"
              // Focusable, and keyboard-operable once focused (finding 14). `role="scrollbar"`
              // without a tab stop is a control that announces itself to a screen reader and
              // then cannot be reached or used by one.
              tabIndex={0}
              aria-label={t.scrollbarAria}
              aria-controls={VIEWPORT_ID}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              // Position within the thumb's TRAVEL, so 100 is reachable — see
              // `scrollbarValueNow`.
              aria-valuenow={scrollbarValueNow(view, contentSpanMs)}
              onPointerDown={onScrollbarDown}
              onPointerMove={onScrollbarMove}
              onPointerUp={onScrollbarUp}
              onPointerCancel={onScrollbarUp}
              onKeyDown={onScrollbarKeyDown}
            >
              <div
                className="timeline__thumb"
                style={{ left: `${bar.offsetFrac * 100}%`, width: `${bar.thumbFrac * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Everything this component says in WORDS is rendered HERE and drawn THERE (V06-R1
          D-075, extended by V06-R2b D-083). The transport is built from `audioClips`, the
          memo that also feeds `engine.setClips`; the legend is built from `legend`, the meta
          sentence from `result`/`clipCount`/`legend`, and the off-session line from
          `outsideWindow`/`outsideWindowDays`. Every one of those is a memo of this
          component's, so lifting any of them to App would mean a second place that derives
          the same thing from the same manifest. A portal moves the pixels without moving the
          ownership.

          After this the timeline element contains ONE child, `.timeline__frame`, and the
          frame therefore starts at the top of the stage in every phase — which is what makes
          the frame's y identical before and after a sync (asserted in `ett-rom.spec`). Null
          `slotEl` only happens for the one commit before App's callback ref has run. */}
      {slotEl !== null &&
        createPortal(
          <>
            {result ? (
              <Transport t={t} clips={audioClips} fps={fps} />
            ) : (
              <>
                {/* The legend (V05-W3). Not "N files have no recording time" any more: the
                    ladder (D-067) means a drop divides into four different situations, and
                    one number covering all of them was what let 174 of the owner's files
                    share one sentence. In the slot it is the counts alone and the whole
                    sentence is its `title` — the four numbers ARE the claim, and 38 px does
                    not hold four clauses beside a transport and a meta line (D-083). */}
                {legend.placed + legend.estimated + legend.ordered + legend.offSession > 0 && (
                  <p className="timeline__note" title={t.presyncLegend(legend)}>
                    {t.presyncLegendShort(legend)}
                  </p>
                )}
                {/* …and the off-session files get their own line, which NAMES THE DATE. That
                    is what makes it actionable: the owner recognises «13.06.2023» as the
                    June drone folder instantly, and would recognise nothing at all in «14
                    filer» — so this one keeps its whole sentence, and ellipsises rather than
                    being shortened. Nothing is removed: D-062's per-file removal is the
                    operator's, not the app's (D-071). */}
                {outsideWindowDays.length > 0 && (
                  <p className="timeline__note timeline__note--offsession">
                    {t.presyncOffSession(outsideWindow.size, outsideWindowDays.map(t.presyncDay))}
                  </p>
                )}
              </>
            )}
            <div className="result__meta">
              <span title={metaSentence}>{metaSentence}</span>
            </div>
          </>,
          slotEl,
        )}

      {/* The result's own warnings (V06-R2b, D-083). They were banners stacked above the
          frame — the exact shape D-082 took out of the room everywhere else — and they are a
          count on the strip now, beside the problem chip, because "is anything wrong?" is one
          question and the operator asks it in one place. Absent when there are none: a
          permanent «0 advarsler» is a line read past on every clean run. */}
      {warnings.length > 0 &&
        stripStatusEl !== null &&
        createPortal(<WarningsChip t={t} warnings={warnings} />, stripStatusEl)}
    </section>
  );
}

/** The strip's warnings chip and the list behind it (V06-R2b, D-083) — R2a's popover shape
 *  (D-078), unchanged: a `<summary>` that is already a control the strip wanted anyway, a
 *  panel that OVERLAYS the room rather than taking space in it, and `usePopoverDismiss` for
 *  the two behaviours `<details>` has no opinion about. */
function WarningsChip({ t, warnings }: { t: Strings; warnings: readonly Warning[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(ref);
  const title = t.warningsCount(warnings.length);

  return (
    <details className="popover popover--warnings" ref={ref}>
      <summary className="chip badge--warn">{title}</summary>
      <div className="popover__panel" role="group" aria-label={title}>
        {warnings.map((w, i) => (
          <p key={i} className="warnrow">
            {warningText(t, w)}
          </p>
        ))}
      </div>
    </details>
  );
}
