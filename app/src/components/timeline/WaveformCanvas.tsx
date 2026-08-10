import { useCallback, useEffect, useRef, useState } from "react";
import type { Strings } from "../../i18n";
import type { TimelineView } from "../../timeline/geometry";
import {
  barAmplitudes,
  barGeometry,
  type BarGeometry,
  type ClipExtent,
} from "../../timeline/waveformDraw";
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
 *     same button relabelled with the "already busy, try again" copy, since the conflict
 *     is expected to clear on its own; `other` gets a retry affordance too — a transient
 *     level-fetch failure must not kill a clip's waveform for the rest of the session
 *     (finding 7), and re-reading is always safe.
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
  /** Cancel handle for the most recent `loadMeta()`. The effect below has its own
   *  cleanup, but `runRegenerate`/`retry` call `loadMeta()` outside any effect and would
   *  otherwise drop the handle on the floor — a resolved-after-unmount `setMeta` and no
   *  way to supersede an in-flight load with a newer one (finding 8). */
  const cancelMetaRef = useRef<(() => void) | null>(null);

  const loadMeta = useCallback(() => {
    cancelMetaRef.current?.();
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
    const cancel = () => {
      cancelled = true;
      if (cancelMetaRef.current === cancel) cancelMetaRef.current = null;
    };
    cancelMetaRef.current = cancel;
    return cancel;
  }, [file, t]);

  // A fresh file (the virtualization window recycling this DOM node onto a different
  // clip) is a fresh everything — old bytes for a different clip must never flash up
  // while the new fetch is in flight.
  useEffect(() => {
    setMeta(null);
    return loadMeta();
  }, [loadMeta]);

  // Unmount: whatever load is outstanding, whoever started it.
  useEffect(() => () => cancelMetaRef.current?.(), []);

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

  // Recovery from an `other` error (finding 7).
  //
  // The draw effect is gated on `!error`, and before this only `loadMeta` cleared it —
  // reachable only on a file change or a regenerate, neither of which the `other` branch
  // offers. So one transient level-fetch failure (an IO blip, a sweep that raced the
  // read) killed that clip's waveform for the rest of the session, with nothing to click.
  //
  // The trigger is a material ZOOM change, quantized to powers of two, rather than any
  // `view` change: `scrollMs` updates on every pointer-move of a pan and would turn a
  // permanently unreadable file into a fetch storm, whereas the zoom bucket takes at most
  // ~17 distinct values across the whole `MIN_PX_PER_MS`…`MAX_PX_PER_MS` range. It is
  // also the change that actually matters to a waveform — a different zoom wants a
  // different level, i.e. a different read. Not `regenerate_analysis`: an unexpected shell
  // error is no evidence the cache needs rebuilding, and re-extracting a card-dump-sized
  // file is far too big a hammer to fire without being asked.
  const zoomBucket = Math.round(Math.log2(view.pxPerMs));
  const isOther = error?.kind === "other";
  /** The zoom bucket the standing `other` error was raised at. Retrying is gated on
   *  LEAVING it, so an error that reproduces immediately settles rather than looping: one
   *  attempt per bucket, at most. */
  const erroredAtBucket = useRef<number | null>(null);
  useEffect(() => {
    if (!isOther) {
      erroredAtBucket.current = null;
      return;
    }
    if (erroredAtBucket.current === null) {
      erroredAtBucket.current = zoomBucket;
      return;
    }
    if (erroredAtBucket.current === zoomBucket) return;
    erroredAtBucket.current = zoomBucket;
    // `invalidate` because `waveformStore` only evicts a rejection it observed itself —
    // the level fetch that failed may still be sitting in `levelCache`.
    invalidate(file);
    loadMeta();
  }, [zoomBucket, isOther, file, loadMeta]);

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
    // Both are answered by the same action — rebuild this one clip's analysis — so both
    // get the same control, relabelled. "busy" (D-046: a sync or another maintenance pass
    // is already running) is expected to clear on its own, and now says so in the user's
    // own language instead of surfacing the engine's raw English refusal through
    // `errUnknown` (finding 6); the raw detail moves to the `title`, where it stays
    // available without shouting in a ~28 px slot that cannot wrap.
    const label = regenerating
      ? t.waveformRegenerating
      : error.kind === "busy"
        ? t.waveformBusy
        : t.waveformRegenerate;
    return (
      <span
        role="button"
        tabIndex={regenerating ? -1 : 0}
        aria-disabled={regenerating}
        className="waveform__regenerate"
        title={error.text}
        onClick={onRegenerate}
        onKeyDown={onRegenerateKeyDown}
      >
        {label}
      </span>
    );
  }

  if (error) {
    // `other` — an unexpected shell error. Deliberately NOT a control, unlike the two
    // above: `.clip__waveform` is centred and fills the whole clip, so a `role="button"`
    // here would sit exactly where the user aims to click the clip itself and would
    // swallow that click (`stopPropagation`), making a clip with a broken waveform
    // impossible to select. The two cases above earn that cost — they are the only way to
    // get the waveform back and the user went looking for them. This one does not:
    // recovery is automatic (see the zoom-bucket effect above), so the honest thing here
    // is a status line the clip can still be clicked through, with the detail on hover.
    return (
      <span className="waveform__status" title={error.text}>
        {t.waveformUnavailable}
      </span>
    );
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
  // Bounds-checked and stride-aware in one place, off the canvas — see `barAmplitudes`
  // for why reading `bytes` inline here was a NaN trap (finding 3).
  const { peak, rms } = barAmplitudes(geom, bytes);

  ctx.fillStyle = ink(PEAK_ALPHA);
  for (let i = 0; i < geom.binCount; i++) {
    const h = peak[i] * scale;
    // `!(h > 0)`, not `h <= 0`: the latter is false for NaN and lets it through.
    if (!(h > 0)) continue;
    ctx.fillRect(geom.xs[i], mid - h, w, h * 2);
  }

  ctx.fillStyle = ink(RMS_ALPHA);
  for (let i = 0; i < geom.binCount; i++) {
    const h = rms[i] * scale;
    if (!(h > 0)) continue;
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
