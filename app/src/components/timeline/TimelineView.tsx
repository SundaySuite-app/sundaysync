import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { stackClips, type ClipSpan } from "../../timeline/laneLayout";
import { getPlayheadMs, publishPlayheadMs } from "../../timeline/playhead";
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
import type { Device, Placement, ScanManifest, SyncOutcome } from "../../types";
import { ClipDetail } from "./ClipDetail";
import { PlayheadLine } from "./PlayheadLine";
import { Ruler } from "./Ruler";
import { Track } from "./Track";
import { Transport } from "./Transport";
import { UnsyncedShelf } from "./UnsyncedShelf";
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
 * clip-detail dialog, the per-device mute/solo. What works in every phase is everything
 * about *looking*: ruler, zoom, pan, scrollbar, virtualization.
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
 *      its detail dialog keep showing the engine's real `offset_seconds`.
 */

/** Height of one sub-track lane — the 34px the old `.lane__track` used. */
const LANE_H = 34;

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

/** Which of the app's phases this timeline is drawing. */
export type TimelinePhase = "sources" | "syncing" | "result";

/** Everything the tracks are drawn from, whichever phase produced it. */
interface TimelineContent {
  tracks: { device: Device; rows: ClipSpan[][] }[];
  contentSpanMs: number;
  /** Null before a sync: there are spans, but no engine placements behind them. */
  placements: Map<string, Placement> | null;
  audioClips: PlacedClip[];
  unknownDurations: ReadonlySet<string>;
  unknownStart: ReadonlySet<string>;
  /** Device carrying the reference badge — the engine's pick, or the operator's. */
  referenceDevice: string | null;
}

/** Nothing to draw — no manifest yet. Frozen so it is never a fresh identity per render. */
const EMPTY_CONTENT: TimelineContent = {
  tracks: [],
  contentSpanMs: 1,
  placements: null,
  audioClips: [],
  unknownDurations: NO_FILES,
  unknownStart: NO_FILES,
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
  deviceIds,
  onOverride,
  onExclude,
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
  deviceIds: string[];
  onOverride: (file: string, device: string) => void;
  onExclude: (file: string) => void;
}) {
  const [selected, setSelected] = useState<Placement | null>(null);
  const result = outcome?.result ?? null;

  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

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
      contentSpanMs: spanMs,
      placements,
      audioClips,
      unknownDurations,
      unknownStart: NO_FILES,
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
      contentSpanMs: spanMs,
      placements: null,
      audioClips: [],
      unknownDurations: NO_FILES,
      unknownStart: layout.unknownStart,
      referenceDevice,
    };
  }, [outcome, manifest, overrides, reference, excluded]);

  const {
    tracks,
    contentSpanMs,
    placements,
    audioClips,
    unknownDurations,
    unknownStart,
    referenceDevice,
  }: TimelineContent = outcomeContent ?? sourceContent ?? EMPTY_CONTENT;

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

  // Measure the lane column and fit the content into it. The fit re-runs whenever
  // the content changes (a new sync outcome) — but NOT on every resize, or the
  // user's chosen zoom would be thrown away by an incidental window drag.
  const fittedSpan = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setView((v) => {
        const widthPx = w > 0 ? w : v.widthPx;
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
  }, [contentSpanMs, clampS]);

  // A fresh result is a fresh clock: the old playhead pointed into a timeline
  // that no longer exists.
  useEffect(() => {
    publishPlayheadMs(0);
  }, [result]);

  // A pre-sync clip has no detail to show; if one was open when a re-scan pulled the
  // outcome out from under it, close it rather than leaving a dialog describing a
  // placement that no longer exists.
  useEffect(() => {
    if (!result) setSelected(null);
  }, [result]);

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

  // D-062: the shelf is where a file that would not sync gets its ✕. It is the row the
  // operator is most likely to want gone — "this one never works, stop telling me" — and
  // before this stage the only way to act on it was to re-drop the folder without it.
  const shelved = useMemo(
    () => (result ? result.unsynced.filter((u) => !excluded.has(u.file)) : []),
    [result, excluded],
  );

  const toggleMute = useCallback((id: string) => engine.toggleMute(id), [engine]);
  const toggleSolo = useCallback((id: string) => engine.toggleSolo(id), [engine]);
  const showSolo = (result?.devices.length ?? 0) > 1;

  const zoomBy = useCallback(
    (factor: number, anchorX?: number) =>
      setView((v) => {
        const z = zoomAround(v, factor, anchorX ?? v.widthPx / 2);
        return { ...z, scrollMs: clampS(z.scrollMs, z.pxPerMs, v.widthPx) };
      }),
    [clampS],
  );

  const fit = useCallback(
    () =>
      setView((v) => ({
        ...v,
        pxPerMs: fitPxPerMs(contentSpanMs, v.widthPx),
        scrollMs: 0,
      })),
    [contentSpanMs],
  );

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
      const delta = e.deltaX || e.deltaY;
      setView((v) => ({
        ...v,
        scrollMs: clampS(v.scrollMs + delta / v.pxPerMs, v.pxPerMs, v.widthPx),
      }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, clampS]);

  // ---- Background drag = pan ----
  const pan = useRef<{ x: number; scrollMs: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Controls and the ruler own their own pointer gestures.
    const target = e.target as HTMLElement;
    if (target.closest("button, select, label, .timeline__ruler")) return;
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
      <div className="result__meta">
        <span>
          {result
            ? t.sequenceMeta(
                result.sequence.fps,
                formatDuration(result.sequence.duration_seconds),
              )
            : t.presyncMeta}
        </span>
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

      {result?.warnings.map((w, i) => (
        <p key={i} className="banner banner--warn">
          <span>{warningText(t, w)}</span>
        </p>
      ))}

      {/* A recorder that wrote no timestamp has told us nothing about when it started, so
          its clips sit at the very start of the timeline. Without this line that reads as
          "the app thinks these all began together", which is a claim nobody made. */}
      {unknownStart.size > 0 && (
        <p className="timeline__note">{t.presyncUnknownStart(unknownStart.size)}</p>
      )}

      <div className="timeline__frame">
        <div
          className="timeline__body"
          ref={bodyRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div className="track track--ruler">
            <div className="track__gutter" />
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
              unknownStart={unknownStart}
              prewarm={prewarm}
              laneHeight={LANE_H}
              onSelect={setSelected}
              muted={playback.muted.includes(device.id)}
              soloed={playback.soloed.includes(device.id)}
              showSolo={showSolo}
              showMix={result !== null}
              onToggleMute={toggleMute}
              onToggleSolo={toggleSolo}
            />
          ))}

          {/* The playhead is the transport's marker; before a sync there is nothing to
              play and no schedule for it to point into. */}
          {result && (
            <div className="timeline__overlay">
              <PlayheadLine view={view} />
            </div>
          )}
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

      {result && <Transport t={t} clips={audioClips} fps={fps} />}

      {result && shelved.length > 0 && (
        <UnsyncedShelf
          t={t}
          unsynced={shelved}
          deviceIds={deviceIds}
          onOverride={onOverride}
          onExclude={onExclude}
        />
      )}

      {selected && result && (
        <ClipDetail
          t={t}
          clip={selected}
          minPsr={result.parameters.min_psr}
          deviceIds={deviceIds}
          onOverride={onOverride}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
