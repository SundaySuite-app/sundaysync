import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Strings } from "../../i18n";
import { formatDuration } from "../../i18n";
import {
  visibleRange,
  xToMs,
  zoomAround,
  type TimelineView as View,
} from "../../timeline/geometry";
import { stackClips, type ClipSpan } from "../../timeline/laneLayout";
import { publishPlayheadMs } from "../../timeline/playhead";
import {
  clampScroll,
  contentBounds,
  fitPxPerMs,
  scrollbarFracToScrollMs,
  scrollbarMetrics,
} from "../../timeline/viewport";
import type { Placement, SyncOutcome } from "../../types";
import { ClipDetail } from "./ClipDetail";
import { PlayheadLine } from "./PlayheadLine";
import { Ruler } from "./Ruler";
import { Track } from "./Track";
import { UnsyncedShelf } from "./UnsyncedShelf";
import { warningText } from "./warnings";

/**
 * §9.4's result view, rebuilt as a real timeline (v0.3, D-051).
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

const VIEWPORT_ID = "timeline-viewport";

export function TimelineView({
  t,
  outcome,
  stale,
  deviceIds,
  onOverride,
}: {
  t: Strings;
  outcome: SyncOutcome;
  stale: boolean;
  deviceIds: string[];
  onOverride: (file: string, device: string) => void;
}) {
  const [selected, setSelected] = useState<Placement | null>(null);
  const { result, durations } = outcome;

  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // ---- Content: seconds → ms, grouped per device, stacked into sub-tracks ----
  const { tracks, contentSpanMs, placements } = useMemo(() => {
    const placements = new Map<string, Placement>();
    for (const p of result.placements) placements.set(p.file, p);

    const spans: ClipSpan[] = result.placements.map((p) => {
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
    return { tracks, contentSpanMs: spanMs, placements };
  }, [result, durations]);

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
  // the whole window.
  useEffect(() => {
    const el = bodyRef.current;
    const viewport = viewportRef.current;
    if (!el || !viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const anchorX = e.clientX - viewport.getBoundingClientRect().left;
        zoomBy(e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR, anchorX);
      } else {
        const delta = e.deltaX || e.deltaY;
        setView((v) => ({
          ...v,
          scrollMs: clampS(v.scrollMs + delta / v.pxPerMs, v.pxPerMs, v.widthPx),
        }));
      }
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

  function scrubScrollbar(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    setView((v) => ({ ...v, scrollMs: scrollbarFracToScrollMs(frac, v, contentSpanMs) }));
  }

  // ---- Keyboard ----
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "+" || e.key === "=") zoomBy(BUTTON_FACTOR);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / BUTTON_FACTOR);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  }

  const [visStart, visEnd] = visibleRange(view);
  const seek = useCallback((x: number) => publishPlayheadMs(Math.max(0, xToMs(x, view))), [view]);

  return (
    <section
      className={`result timeline${stale ? " result--stale" : ""}`}
      aria-label={t.timelineAria}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="result__meta">
        <span>
          {t.sequenceMeta(result.sequence.fps, formatDuration(result.sequence.duration_seconds))}
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

      {result.warnings.map((w, i) => (
        <p key={i} className="banner banner--warn">
          <span>{warningText(t, w)}</span>
        </p>
      ))}

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
              isReference={result.reference?.device === device.id}
              laneHeight={LANE_H}
              onSelect={setSelected}
            />
          ))}

          <div className="timeline__overlay">
            <PlayheadLine view={view} />
          </div>
        </div>

        <div className="track track--scrollbar">
          <div className="track__gutter" />
          <div className="track__lanes">
            <div
              className="timeline__scrollbar"
              role="scrollbar"
              aria-label={t.scrollbarAria}
              aria-controls={VIEWPORT_ID}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(bar.offsetFrac * 100)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                scrubScrollbar(e);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubScrollbar(e);
              }}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
            >
              <div
                className="timeline__thumb"
                style={{ left: `${bar.offsetFrac * 100}%`, width: `${bar.thumbFrac * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {result.unsynced.length > 0 && (
        <UnsyncedShelf
          t={t}
          unsynced={result.unsynced}
          deviceIds={deviceIds}
          onOverride={onOverride}
        />
      )}

      {selected && (
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
