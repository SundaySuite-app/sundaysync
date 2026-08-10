import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Strings } from "../../i18n";
import { waveformFits, type ClipChrome, type ClipStatusKind } from "../../timeline/clipChrome";
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
  getEpoch,
  invalidate,
  regenerateAnalysis,
  releaseWaveformMeta,
  subscribeEpoch,
  type WaveformError,
} from "../../timeline/waveformStore";
import type { PrewarmStatus } from "../../state";
import type { WaveformMeta } from "../../types";

/** Peak drawn as a faint outline behind a solid RMS body — D-053's "planned (S4)" note on
 *  Clypra's draw loop, adapted (see `waveformDraw.ts`'s header for the full attribution). */
const PEAK_ALPHA = 0.32;
const RMS_ALPHA = 0.85;

/** Fraction of the half-height a full-scale (255) bin is allowed to reach, so a peak at
 *  the loudest possible sample does not visually fuse with the clip box's own border. */
const HEADROOM = 0.92;

/** The glyph the rebuild control shrinks to when a clip is too narrow for its sentence
 *  (D-065). It carries no meaning of its own — the element keeps the full localized string
 *  as its `aria-label` and the engine's detail in its `title`, so only the pixels are
 *  rationed. Not an i18n string: a rotation arrow is the same in every language. */
const REGENERATE_GLYPH = "↻";

/**
 * What a clip has to say in its chrome, beside its name (V05-W1, D-065).
 *
 * A *description*, not JSX, because the thing that owns those pixels is `Clip.tsx`: the
 * name and the status are flex siblings in one `.clip__chrome` row, and they cannot be
 * laid out against each other by a component that can only see one of them. That is the
 * whole first half of D-065 — the two used to be independently positioned children drawn
 * on top of one another, and no amount of care inside this file could have stopped it.
 */
export type ClipWaveformStatus =
  | { kind: "none" }
  | {
      kind: "control";
      /** The v0.3 class the control has always had; the e2e suite and the stylesheet both
       *  know it by that name. */
      className: string;
      /** The full localized label — the visible text when there is room, the `aria-label`
       *  when there is not. */
      label: string;
      /** The engine's own detail, for `title`. Never swallowed (§7.5). */
      detail: string;
      disabled: boolean;
      onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
      onKeyDown: (e: React.KeyboardEvent) => void;
    }
  | { kind: "info"; className: string; label: string; detail: string | null };

export interface ClipWaveform {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  status: ClipWaveformStatus;
  /** Is this clip wide enough for a waveform to mean anything (`MIN_WAVEFORM_PX`, D-072)?
   *  False suppresses the `<canvas>` as well as the read behind it — the element, its
   *  backing store and its per-pan draw are all part of the same waste. */
  showCanvas: boolean;
}

/** The discriminant IS `clipChrome`'s `ClipStatusKind` — stated once, so the width rule and
 *  the thing being measured can never drift into two vocabularies. */
export type { ClipStatusKind };

/**
 * The canvas behind `Clip.tsx`'s chrome, and the fetch/draw machinery behind it — v0.3 S4.
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
 *
 * **v0.4 (D-062): `analysisStatus` is a fourth, temporary state.** While the background
 * pre-analysis (D-059) has this file in flight, a cache miss is not a condition to offer a
 * fix for — it is a wait of a few seconds. The regenerate control would be actively wrong
 * there: `regenerate_analysis` does not preempt a prewarm, so pressing it can only earn
 * the D-046 busy refusal, and the bytes it would rebuild are already being written.
 * `pending → ready` is what makes the waveforms appear one by one instead of all at once
 * after a sync; `pending → failed` simply hands the regenerate control back.
 *
 * **v0.5 (D-064): it is a hook, and it returns a DESCRIPTION rather than JSX.** What the
 * clip has to say competes for pixels with the clip's own filename, and the two cannot be
 * laid out against each other by a component that can only see one of them — which is
 * precisely how they came to be drawn on top of each other (D-065). This owns the state and
 * the fetching; `Clip.tsx` owns the row they share. The same decision widened
 * `analysisStatus` to cover a running sync, so «Analyserer …» now stands for the whole time
 * anything is analysing this file, and added the store epoch below, which is what makes a
 * clip re-read after a run instead of replaying a rejection forever.
 */
export function useClipWaveform({
  t,
  file,
  span,
  view,
  widthPx,
  analysisStatus = null,
}: {
  t: Strings;
  file: string;
  span: ClipExtent;
  view: TimelineView;
  /** The clip's drawn width, as `Clip.tsx` computed it. The waveform's whole pipeline —
   *  the IPC, the canvas, the draw — is gated on it since V05-W5 (D-072). */
  widthPx: number;
  /** Where the background pass is with this file (D-062); null when it is not tracking it. */
  analysisStatus?: PrewarmStatus | null;
}): ClipWaveform {
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
      // Idempotent: this is reachable twice (an effect cleanup holding the handle, and the
      // unmount effect reading `cancelMetaRef`), and a second release would decrement
      // another consumer's waiter count — dropping a queued request somebody is still
      // waiting for (V05-W5, D-072).
      if (cancelled) return;
      cancelled = true;
      releaseWaveformMeta(file);
      if (cancelMetaRef.current === cancel) cancelMetaRef.current = null;
    };
    cancelMetaRef.current = cancel;
    return cancel;
  }, [file, t]);

  // The store's epoch (V05-W1, D-064). A wholesale `invalidateAll()` — a sync has just
  // rewritten the analysis cache for every file in the run — drops every memo, and this is
  // what makes a MOUNTED clip go back and look. Without it the drop was silent: this
  // component only ever re-reads on a file change, a regenerate, a `pending → ready`
  // transition or a zoom-bucket change, so a clip that met a `cache_missing` rejection
  // before the run replayed that same rejection for the rest of the session — and the
  // waveform the sync had just built for it never appeared. Subscribed the way
  // `playhead.ts` does it, so a bump costs one render in the clips that are mounted and
  // nothing anywhere else.
  const epoch = useSyncExternalStore(subscribeEpoch, getEpoch);

  /**
   * Is this clip wide enough to be worth a waveform at all (V05-W5, D-072)?
   *
   * A BOOLEAN in the dependency list, not the width and not the zoom bucket, and that is
   * the whole mechanism: a derived boolean only changes when the threshold is *crossed*, so
   * the effect below re-runs exactly once per crossing and never on the hundreds of `view`
   * updates a pan produces. The zoom bucket underneath the `other`-error recovery is too
   * coarse for this — 24 px can be crossed well inside one power-of-two bucket, and a clip
   * that widened past the threshold without changing bucket would sit there empty.
   */
  const fits = waveformFits(widthPx);

  // A fresh file (the virtualization window recycling this DOM node onto a different
  // clip) is a fresh everything — old bytes for a different clip must never flash up
  // while the new fetch is in flight. A fresh epoch is the same event for every file at
  // once, so it re-runs the same way. And a clip that has just grown past
  // `MIN_WAVEFORM_PX` is a clip that now has something to show.
  useEffect(() => {
    void epoch; // read as a *reason to look again*, not as a value this effect uses
    setMeta(null);
    if (!fits) {
      // Below the threshold the clip claims nothing about its waveform. The error is
      // cleared with the meta because a standing `cacheMissing` would otherwise still be
      // offering a rebuild control in a 23 px box, from a read taken at a wider zoom.
      setError(null);
      return;
    }
    return loadMeta();
  }, [loadMeta, epoch, fits]);

  // Unmount: whatever load is outstanding, whoever started it.
  useEffect(() => () => cancelMetaRef.current?.(), []);

  // The progressive half of D-062: the background pass has just WRITTEN this file's
  // analysis. `App.tsx` dropped the store's memo for it (`waveformStore.invalidate`) on
  // the same event, so a plain re-read is all that is needed — and it is needed, because
  // nothing else in this component would ever look again: `loadMeta` re-runs on a file
  // change, and the only answer this clip has is the `cache_missing` rejection from
  // before the pass got to it.
  //
  // Narrow on purpose: only `pending → ready`. A pass that ended without reaching this
  // file (`failed`) wrote nothing, so re-reading could only produce the same rejection —
  // it just stops being a wait, and the render below hands back the regenerate control.
  const lastStatus = useRef(analysisStatus);
  useEffect(() => {
    const arrived = lastStatus.current === "pending" && analysisStatus === "ready";
    lastStatus.current = analysisStatus;
    // …unless there is nowhere to draw it (D-072). A 3 px clip's analysis landing is not a
    // reason to spend an IPC; the read happens when the operator zooms in far enough to
    // have asked for it.
    if (arrived && fits) loadMeta();
  }, [analysisStatus, loadMeta, fits]);

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
          // The SAME `dpr` the geometry was computed from, handed down rather than re-read
          // (V03-S6, finding 15). `drawWaveform` used to call `window.devicePixelRatio`
          // itself, on the far side of this promise — so dragging the window onto a
          // second monitor mid-fetch sized the backing store by one ratio and the bar
          // positions by another. Two sources for one number is how they disagree.
          drawWaveform(canvas, geom, bytes, dpr);
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

  // `stopPropagation` does the half of the job a native nested button would have done for
  // free (`ClipStatus` explains why this cannot be one): the clip underneath is its own
  // click target (it marks the clip for the preview panel), and this control must act on
  // its own click without
  // also triggering that.
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

  const status = ((): ClipWaveformStatus => {
    if (analysisStatus === "pending" && (error?.kind === "cacheMissing" || error?.kind === "busy")) {
      // D-062: not an offer, a status. Deliberately not a control — see the component note
      // above for why the regenerate button would be the wrong thing to show here.
      //
      // V05-W1 (D-064) widened WHEN this is true rather than what it says: `sync/start`
      // now marks every unanalysed file `pending`, because a run really is analysing them.
      // The clip says «analyserer …» for the duration of the sync and never offers a
      // rebuild it could not honour.
      return { kind: "info", className: "waveform__analysing", label: t.waveformAnalysing, detail: null };
    }

    if (error?.kind === "cacheMissing" || error?.kind === "busy") {
      // Both are answered by the same action — rebuild this one clip's analysis — so both
      // get the same control, relabelled. "busy" (D-046: a sync or another maintenance
      // pass is already running) is expected to clear on its own, and says so in the
      // user's own language instead of surfacing the engine's raw English refusal through
      // `errUnknown` (finding 6); the raw detail moves to the `title`, where it stays
      // available without shouting in a slot that cannot wrap.
      const label = regenerating
        ? t.waveformRegenerating
        : error.kind === "busy"
          ? t.waveformBusy
          : t.waveformRegenerate;
      return {
        kind: "control",
        className: "waveform__regenerate",
        label,
        detail: error.text,
        disabled: regenerating,
        onClick: onRegenerate,
        onKeyDown: onRegenerateKeyDown,
      };
    }

    if (error) {
      // `other` — an unexpected shell error. Deliberately NOT a control, unlike the two
      // above: recovery is automatic (see the zoom-bucket effect above), so the honest
      // thing is a status line the clip can still be clicked through, with the detail on
      // hover. `.clip__chrome` is `pointer-events: none` for exactly that reason, which is
      // now a property of the ROW rather than a promise each status has to keep on its own.
      return {
        kind: "info",
        className: "waveform__status",
        label: t.waveformUnavailable,
        detail: error.text,
      };
    }

    return { kind: "none" };
  })();

  return { canvasRef, status, showCanvas: fits };
}

/**
 * The clip's waveform layer: an absolutely-positioned slot filling the clip box, with the
 * `<canvas>` inside it when there is something to draw.
 *
 * Underneath `.clip__chrome`, never mixed into it (D-065). The canvas positions itself in
 * pixels from `barGeometry`, so it cannot be a flex item; the name and the status must be
 * flex items, or they overlap. One layer each, and the stacking order says which is on top
 * instead of two `z-index`es hoping.
 */
export function WaveformCanvas({
  waveform,
  title,
}: {
  waveform: ClipWaveform;
  /** What the slot says on hover when the chrome had no room to say it in the box — the
   *  clip's own `title` (its filename) otherwise, which is why this is usually absent. */
  title?: string;
}) {
  return (
    <span className="clip__waveform" data-waveform-slot="" title={title}>
      {waveform.showCanvas && waveform.status.kind === "none" ? (
        <canvas ref={waveform.canvasRef} className="waveform__canvas" aria-hidden="true" />
      ) : null}
    </span>
  );
}

/**
 * The status child of `.clip__chrome` — a control to press or a line to read, in the form
 * the clip's width can afford (D-065).
 *
 * `mode` comes from `clipChrome()`, never from a measurement taken here: the name and the
 * status are sized by one rule together, and a component that can only see one of them
 * cannot apply it.
 *
 * The control is a `role="button"` SPAN, deliberately not a `<button>`: `Clip.tsx`'s own
 * root IS a real `<button>` (it has to stay one — see its comment), and the HTML parser
 * un-nests a `<button>` inside a `<button>` rather than just failing a validator.
 * `stopPropagation` (in the handler) does the other half of the job a native nested button
 * would have needed anyway.
 */
export function ClipStatus({
  status,
  mode,
}: {
  status: ClipWaveformStatus;
  mode: ClipChrome["status"];
}) {
  if (status.kind === "none" || mode === "none") return null;

  const className = `clip__status ${status.className}${mode === "icon" ? " clip__status--icon" : ""}`;

  if (status.kind === "info") {
    // Never a control and never a click target: there is nothing to press, and this stands
    // exactly where the operator aims to click the clip itself.
    return (
      <span className={className} title={status.detail ?? undefined}>
        {status.label}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={status.disabled ? -1 : 0}
      aria-disabled={status.disabled}
      // The icon form is pixels-only rationing: the accessible name is the whole sentence
      // either way, and a screen reader hears no difference between a 22 px clip and a
      // 400 px one.
      aria-label={mode === "icon" ? status.label : undefined}
      className={className}
      title={status.detail}
      onClick={status.onClick}
      onKeyDown={status.onKeyDown}
    >
      {mode === "icon" ? REGENERATE_GLYPH : status.label}
    </span>
  );
}

/**
 * One pass over `geom`'s visible bins: peak as a low-alpha outline, RMS as a solid body
 * on top, both symmetric around the canvas's own vertical centre — the peak+RMS-together
 * convention D-052/D-053 call out as what makes a waveform readable rather than a solid
 * block. Colour is read from the canvas's own computed `color` at draw time rather than
 * passed as a prop: `Clip.tsx`'s `.clip`/`.clip--warn` classes already set it (the same
 * near-black ink the clip's own label uses), so the waveform automatically tracks the
 * §9.4 green/orange state without this component needing to know why.
 *
 * `dpr` is a PARAMETER, not a fresh `window.devicePixelRatio` read: `geom` was built from
 * one ratio before the level fetch, and re-reading it here after the fetch resolved gave
 * the backing store a different scale from the bar positions inside it whenever the two
 * disagreed (finding 15).
 */
function drawWaveform(
  canvas: HTMLCanvasElement,
  geom: BarGeometry,
  bytes: Uint8Array,
  dpr: number,
): void {
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
