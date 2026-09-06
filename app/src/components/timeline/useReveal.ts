import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { TimelineView as View } from "../../timeline/geometry";
import type { ClipSpan } from "../../timeline/laneLayout";
import { REVEAL_MS, revealScrollTop, revealTarget, subscribeReveal } from "../../timeline/reveal";
import { clampScroll } from "../../timeline/viewport";
import type { Device, Unsynced } from "../../types";
import { motionAllowed } from "./useHop";

/**
 * «Kilder» finds the clip: the part of the reveal that touches the DOM (F, D-096).
 *
 * The arithmetic is in `timeline/reveal.ts` and is unit-tested there; what is here is the
 * three writes that arithmetic produces, and the one rule about who is allowed to ask for
 * them.
 *
 * ## Only the popover asks
 *
 * `subscribeReveal` listens on the channel `SourcesPopover` publishes to and nothing else
 * publishes to. A click on a CLIP must never move the view: the operator is looking at the
 * box they clicked, and a timeline that panned under that click would move the very thing
 * their eye is on. What makes «Kilder» different is that the file was chosen BY NAME, from a
 * list, with no idea where it is — reaching it is the whole errand.
 *
 * ## Three writes, and why each is the shape it is
 *
 *   - **The pan and the zoom** are one interpolated ~250 ms rAF over `view`, in the shape
 *     `useHop`'s own closing fit already established: zoom moves GEOMETRICALLY (it is a
 *     ratio; a linear ramp crawls at one end and lurches at the other), pan linearly, both on
 *     the same ease-out so the two read as one gesture. `data-reveal` is on the section for
 *     exactly as long as it runs — real state, and the thing the browser tier waits on
 *     instead of sampling a tween.
 *   - **The vertical** is `.timeline__scroll`'s own `scrollTop`, written as a number.
 *     **`scrollIntoView` is forbidden here**, and the suite has the scar for it: it scrolls
 *     *every* scrollable ancestor, so "bring this row into view" inside a timeline moves the
 *     page and anything else with an overflow between the row and the document. It is instant
 *     rather than animated because it is not the journey — the journey is along the time
 *     axis, and a column that slid at the same time would be a second movement competing with
 *     the one the operator is meant to read.
 *   - **The pulse** is 600 ms of gold on the box itself, applied after the view has come to
 *     rest — which is the only moment the node is guaranteed to exist, since a clip outside
 *     the virtualization window has no DOM node at all until the view reaches it.
 *
 * Under reduced motion the first is a single assignment, and the third does not happen: a
 * pulse is decoration, and the answer to "where is it?" is the clip being there.
 *
 * ## Why the row is MEASURED here when `hop.ts` refuses to measure anything
 *
 * They are different questions. The hop needs where the clips WERE, after React has committed
 * where they now are — a DOM read at that point returns the new layout, so the old one can
 * only be arithmetic. The reveal needs where the row IS, in the layout on screen, and
 * `offsetTop` inside `.timeline__body` is that number by definition. Recomputing it would be
 * a second statement of the track-height sum that `trackHeightFor` exists to be the only
 * producer of.
 */

/** On the section while the view is travelling under its own power. Same bargain as
 *  `HOP_ATTR`: real state, and what a spec waits on rather than sampling a frame. */
export const REVEAL_ATTR = "data-reveal";

/** «Here it is.» On the revealed box for {@link REVEAL_PULSE_MS}, then off again. */
export const REVEAL_PULSE_CLASS = "reveal--found";

/** Long enough to catch an eye that was reading a filename a moment ago, short enough not to
 *  become a second selection state competing with the gold ring that stays. */
export const REVEAL_PULSE_MS = 600;

/** Where a file lives on the timeline: whose row it is on, and — if it was placed at all —
 *  the span the view has to travel to. */
interface RevealHome {
  device: string;
  /** Null for a file the run refused: it has a row (its device's pill strip) and no x. */
  span: ClipSpan | null;
}

/** The tracks as this hook needs them — `TimelineView`'s own shape, narrowed. */
export interface RevealTrack {
  device: Device;
  rows: ClipSpan[][];
  unsynced: readonly Unsynced[];
}

/**
 * Whose row this file is on. Drawn clips first, then the pill strips — a file cannot be both,
 * and a placed file is the common case, so it is the one that is answered without walking the
 * refusals.
 */
function findHome(tracks: readonly RevealTrack[], file: string): RevealHome | null {
  for (const { device, rows } of tracks) {
    for (const row of rows) {
      for (const span of row) if (span.file === file) return { device: device.id, span };
    }
  }
  for (const { device, unsynced } of tracks) {
    for (const u of unsynced) if (u.file === file) return { device: device.id, span: null };
  }
  return null;
}

/**
 * The element carrying `data-<attribute>` equal to `value`, compared as a STRING.
 *
 * Never a built attribute selector: a POSIX path may contain quotes, brackets and backslashes,
 * and `[data-file="…"]` built from one is a parse error on exactly the drops that are hardest
 * to reproduce. The same rule `useHop` follows for the very same reason.
 */
function byData(root: HTMLElement, attribute: "file" | "device", value: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-${attribute}]`)) {
    if (el.dataset[attribute] === value) return el;
  }
  return null;
}

/** Everything one reveal in flight has to be able to undo. */
interface RevealRun {
  raf: number | null;
  timers: ReturnType<typeof setTimeout>[];
  /** The node wearing the pulse, so a second reveal does not leave gold behind on the first. */
  pulsed: HTMLElement | null;
}

export interface RevealHandle {
  /** Abandon a reveal in flight and leave the view exactly where it is. Called by every
   *  gesture that takes the view, for the same reason `useHop.cancel` is. */
  cancel: () => void;
}

export function useReveal({
  tracks,
  view,
  contentSpanMs,
  sectionRef,
  stageRef,
  bodyRef,
  setView,
  cancelHop,
}: {
  tracks: readonly RevealTrack[];
  view: View;
  contentSpanMs: number;
  /** The `.timeline` section — where `data-reveal` goes. */
  sectionRef: RefObject<HTMLElement>;
  /** `.timeline__scroll`, the ONE box whose `scrollTop` is written. */
  stageRef: RefObject<HTMLDivElement>;
  /** `.timeline__body` — the tracks and the clips are looked up inside it. */
  bodyRef: RefObject<HTMLDivElement>;
  setView: (update: (v: View) => View) => void;
  cancelHop: () => void;
}): RevealHandle {
  /**
   * The current layout and view, for a subscriber that outlives the render it was made in.
   *
   * A ref rather than a dependency list: `view` changes on every frame of every pan, and a
   * subscription that re-registered per frame would be a `Set` churned sixty times a second
   * for a listener that is called once a minute at most.
   */
  const latest = useRef({ tracks, view, contentSpanMs });
  latest.current = { tracks, view, contentSpanMs };

  const run = useRef<RevealRun | null>(null);

  const cancel = useCallback(() => {
    const current = run.current;
    run.current = null;
    sectionRef.current?.removeAttribute(REVEAL_ATTR);
    if (!current) return;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    for (const timer of current.timers) clearTimeout(timer);
    current.pulsed?.classList.remove(REVEAL_PULSE_CLASS);
  }, [sectionRef]);

  useEffect(() => {
    const reveal = (file: string) => {
      const section = sectionRef.current;
      const stage = stageRef.current;
      const body = bodyRef.current;
      if (!section || !stage || !body) return;
      const { tracks: drawn, view: from, contentSpanMs: span } = latest.current;
      const home = findHome(drawn, file);
      // Fire-and-forget: a file with no row at all — excluded, or from a scan that has been
      // replaced — has nowhere to be taken to, and that is the honest behaviour.
      if (home === null) return;

      // The reveal takes the view, so anything else holding it has to let go first — the
      // hop describes a journey between two positions on a stationary canvas, and this is
      // the canvas moving.
      cancelHop();
      cancel();
      const current: RevealRun = { raf: null, timers: [], pulsed: null };
      run.current = current;

      /** «Here it is», once the box exists to say it about. */
      const pulse = () => {
        if (run.current !== current || !motionAllowed()) return;
        const node = byData(body, "file", file);
        if (!node) return;
        node.classList.add(REVEAL_PULSE_CLASS);
        current.pulsed = node;
        current.timers.push(
          setTimeout(() => {
            node.classList.remove(REVEAL_PULSE_CLASS);
            if (current.pulsed === node) current.pulsed = null;
          }, REVEAL_PULSE_MS),
        );
      };
      /** …on the next task, so React has committed the view the node is drawn under. A clip
       *  outside the virtualization window has no node until the view has reached it. */
      const pulseWhenDrawn = () => current.timers.push(setTimeout(pulse, 0));

      // ---- The vertical half: one box's `scrollTop`, and never `scrollIntoView` ----------
      const trackEl = byData(body, "device", home.device);
      const ruler = body.querySelector<HTMLElement>(".track--ruler");
      if (trackEl) {
        stage.scrollTop = revealScrollTop(
          { top: trackEl.offsetTop, height: trackEl.offsetHeight },
          stage.scrollTop,
          stage.clientHeight,
          ruler?.offsetHeight ?? 0,
          stage.scrollHeight - stage.clientHeight,
        );
      }

      // ---- The horizontal half ---------------------------------------------------------
      // A refused file has no span and therefore no x to travel to; its row is what was
      // asked for, and the scroll above has already given it.
      const target = home.span === null ? null : revealTarget(home.span, from, span);
      if (target === null) {
        // Already comfortable (or nothing to be comfortable about). Not an optimisation —
        // it is the behaviour: picking a file that is on screen and legible must not move
        // the timeline, or «Kilder» would be a control that jiggles the view on every use.
        pulseWhenDrawn();
        return;
      }
      if (!motionAllowed()) {
        setView((v) => ({ ...v, pxPerMs: target.pxPerMs, scrollMs: target.scrollMs }));
        run.current = null;
        return;
      }

      section.setAttribute(REVEAL_ATTR, "");
      const t0 = performance.now();
      const step = (now: number) => {
        if (run.current !== current) return;
        const p = Math.min(1, (now - t0) / REVEAL_MS);
        // The same ease-out the closing fit uses, so a reveal and a post-sync fit are one
        // vocabulary rather than two moves that happen to take the same time.
        const eased = 1 - Math.pow(1 - p, 3);
        setView((v) => {
          const pxPerMs = from.pxPerMs * Math.pow(target.pxPerMs / from.pxPerMs, eased);
          const scrollMs = from.scrollMs + (target.scrollMs - from.scrollMs) * eased;
          return { ...v, pxPerMs, scrollMs: clampScroll(scrollMs, pxPerMs, v.widthPx, span) };
        });
        if (p < 1) {
          current.raf = requestAnimationFrame(step);
          return;
        }
        // Arrived. The attribute comes off in the same statement that stops the travel, so
        // "the timeline is moving" and "the timeline is moving" are one fact and not two.
        current.raf = null;
        section.removeAttribute(REVEAL_ATTR);
        pulseWhenDrawn();
      };
      current.raf = requestAnimationFrame(step);
    };
    return subscribeReveal(reveal);
  }, [bodyRef, cancel, cancelHop, sectionRef, setView, stageRef]);

  // Nothing may outlive the component: a rAF would call `setView` on a gone tree, and a
  // timer would reach for a detached node.
  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ cancel }), [cancel]);
}
