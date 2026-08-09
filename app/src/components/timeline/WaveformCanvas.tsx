import { useCallback, useEffect, useRef, useState } from "react";
import type { Strings } from "../../i18n";
import type { TimelineView } from "../../timeline/geometry";
import { barGeometry, type BarGeometry, type ClipExtent } from "../../timeline/waveformDraw";
import {
  classifyWaveformError,
  fetchWaveformLevel,
  fetchWaveformMeta,
  invalidate,
  regenerateAnalysis,
  type WaveformError,
} from "../../timeline/waveformStore";
import type { WaveformMeta } from "../../types";

/** Peak drawn as a faint outline behind a solid RMS body — D-053's "planned (S4)" note on
 *  Clypra's draw loop, adapted (see `waveformDraw.ts`'s header for the full attribution). */
const PEAK_ALPHA = 0.32;
const RMS_ALPHA = 0.85;

/** Fraction of the half-height a full-scale (255) bin is allowed to reach, so a peak at
 *  the loudest possible sample does not visually fuse with the clip box's own border. */
const HEADROOM = 0.92;

/**
 * The canvas that fills `Clip.tsx`'s `.clip__waveform` slot — v0.3 S4.
 *
 * Three states, and only three:
 *   - **loading** — nothing rendered. The wait for a resident (or freshly streamed)
 *     pyramid read is imperceptible on the timeline's own virtualization window, and a
 *     spinner that appears and vanishes inside one frame reads as a flicker, not a
 *     status. The bare clip (colour + label) is not a broken state; S3 already carries
 *     the whole thing on its own.
 *   - **drawn** — the `<canvas>`.
 *   - **error** — one of `waveformStore.ts`'s `classifyWaveformError` outcomes:
 *     `cacheMissing` gets the regenerate button (D-052's whole point); `busy` gets the
 *     same button relabelled with the D-046 refusal text, since the conflict is expected
 *     to clear on its own; `other` gets a plain "unavailable" line, nothing to retry.
 *
 * Sizing is deliberately NOT "the clip's full zoomed width": `barGeometry` intersects the
 * clip against the viewport first, so a 60-minute clip at a tight zoom never asks for a
 * 100 000px-wide backing store. Pan/zoom redraw through one rAF per `view` change, so a
 * wheel-driven drag (many `view` updates a second) never queues more than one draw.
 */
export function WaveformCanvas({
  t,
  file,
  span,
  view,
}: {
  t: Strings;
  file: string;
  span: ClipExtent;
  view: TimelineView;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [meta, setMeta] = useState<WaveformMeta | null>(null);
  const [error, setError] = useState<WaveformError | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const loadMeta = useCallback(() => {
    let cancelled = false;
    setError(null);
    fetchWaveformMeta(file).then(
      (m) => {
        if (!cancelled) setMeta(m);
      },
      (e: unknown) => {
        if (!cancelled) setError(classifyWaveformError(e, t));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file, t]);

  // A fresh file (the virtualization window recycling this DOM node onto a different
  // clip) is a fresh everything — old bytes for a different clip must never flash up
  // while the new fetch is in flight.
  useEffect(() => {
    setMeta(null);
    return loadMeta();
  }, [loadMeta]);

  // Draw: rAF-throttled against `view` (pan/zoom), `span` (a placement override moving
  // this clip), and `meta`. Level bytes are fetched lazily, only once meta is in and only
  // for the level the current zoom actually needs — `waveformStore.ts` dedupes the
  // `invoke`, so re-visiting an already-seen zoom never re-fetches.
  useEffect(() => {
    if (!meta || error) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const geom = barGeometry(span, meta, view, dpr);
      const canvas = canvasRef.current;
      if (!geom || !canvas) return;
      fetchWaveformLevel(file, geom.level).then(
        (bytes) => {
          if (cancelled) return;
          drawWaveform(canvas, geom, bytes);
        },
        (e: unknown) => {
          if (!cancelled) setError(classifyWaveformError(e, t));
        },
      );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [meta, error, view, span, file, t]);

  const runRegenerate = useCallback(() => {
    setRegenerating(true);
    regenerateAnalysis(file).then(
      () => {
        invalidate(file);
        setRegenerating(false);
        loadMeta();
      },
      (e2: unknown) => {
        setRegenerating(false);
        setError(classifyWaveformError(e2, t));
      },
    );
  }, [file, loadMeta, t]);

  // A `role="button"` SPAN, deliberately not a `<button>`: `Clip.tsx`'s own root IS a
  // real `<button>` (it has to stay one — see its comment), and the HTML parser un-nests
  // a `<button>` inside a `<button>` rather than just failing a validator. `stopPropagation`
  // does the other half of the job a native nested button would have needed anyway: the
  // clip underneath is its own click target (opens ClipDetail), and this control must act
  // on its own click without also triggering that.
  const onRegenerate = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      if (!regenerating) runRegenerate();
    },
    [regenerating, runRegenerate],
  );
  const onRegenerateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onRegenerate(e);
      }
    },
    [onRegenerate],
  );

  if (error?.kind === "cacheMissing" || error?.kind === "busy") {
    // "busy" (D-046: a sync or another maintenance pass is already running) is retryable
    // — the conflict is expected to clear on its own — so it gets the same regenerate
    // action as a genuine cache miss, just relabelled with the refusal text instead of
    // the usual button copy.
    const label = regenerating
      ? t.waveformRegenerating
      : error.kind === "busy"
        ? error.text
        : t.waveformRegenerate;
    return (
      <span
        role="button"
        tabIndex={regenerating ? -1 : 0}
        aria-disabled={regenerating}
        className="waveform__regenerate"
        onClick={onRegenerate}
        onKeyDown={onRegenerateKeyDown}
      >
        {label}
      </span>
    );
  }

  if (error) {
    return <span className="waveform__status">{t.waveformUnavailable}</span>;
  }

  return <canvas ref={canvasRef} className="waveform__canvas" aria-hidden="true" />;
}

/**
 * One pass over `geom`'s visible bins: peak as a low-alpha outline, RMS as a solid body
 * on top, both symmetric around the canvas's own vertical centre — the peak+RMS-together
 * convention D-052/D-053 call out as what makes a waveform readable rather than a solid
 * block. Colour is read from the canvas's own computed `color` at draw time rather than
 * passed as a prop: `Clip.tsx`'s `.clip`/`.clip--warn` classes already set it (the same
 * near-black ink the clip's own label uses), so the waveform automatically tracks the
 * §9.4 green/orange state without this component needing to know why.
 */
function drawWaveform(canvas: HTMLCanvasElement, geom: BarGeometry, bytes: Uint8Array): void {
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = canvas.clientHeight;
  if (geom.widthCssPx <= 0 || cssHeight <= 0) return;

  const deviceWidth = Math.max(1, Math.round(geom.widthCssPx * dpr));
  const deviceHeight = Math.max(1, Math.round(cssHeight * dpr));
  // Resizing the backing store clears it, so only touch it when the size actually
  // changed — most redraws (a plain pan) keep the same visible width.
  if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
  if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
  canvas.style.left = `${geom.leftCssPx}px`;
  canvas.style.width = `${geom.widthCssPx}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);

  const ink = withAlpha(getComputedStyle(canvas).color);
  const mid = deviceHeight / 2;
  const scale = mid * HEADROOM;
  const w = geom.barWidthPx;

  ctx.fillStyle = ink(PEAK_ALPHA);
  for (let i = 0; i < geom.binCount; i++) {
    const peak = bytes[(geom.binStart + i) * 2] / 255;
    const h = peak * scale;
    if (h <= 0) continue;
    ctx.fillRect(geom.xs[i], mid - h, w, h * 2);
  }

  ctx.fillStyle = ink(RMS_ALPHA);
  for (let i = 0; i < geom.binCount; i++) {
    const rms = bytes[(geom.binStart + i) * 2 + 1] / 255;
    const h = rms * scale;
    if (h <= 0) continue;
    ctx.fillRect(geom.xs[i], mid - h, w, h * 2);
  }
}

/** `getComputedStyle(...).color` always resolves to `rgb(r, g, b)` (browsers normalise
 *  computed colour values), never the `#hex`/named form the CSS source uses — this
 *  reaches into that and hands back a closure that swaps in whatever alpha the caller
 *  wants, so the two draw passes above share one parsed colour. Falls back to the raw
 *  string (opaque) if the computed value is ever something this does not expect, rather
 *  than throwing mid-draw. */
function withAlpha(computed: string): (alpha: number) => string {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed);
  if (!m) return () => computed;
  const [, r, g, b] = m;
  return (alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
