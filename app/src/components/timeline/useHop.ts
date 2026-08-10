import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { TimelineView as View } from "../../timeline/geometry";
import { CLIP_HEIGHT_PX, hopDeltas, hopExits, type HopTrack } from "../../timeline/hop";
import { clampScroll, fitPxPerMs } from "../../timeline/viewport";

/**
 * The clips hop into place when the sync lands (v0.4, D-063).
 *
 * «Når man klikker sync, så *hopper* filene på plass når de får en match. Det skal være
 * veldig smooth.» The whole of that sentence is three moves in a fixed order, and the order
 * is the design:
 *
 *   1. **Freeze.** The commit that first carries an outcome renders the solved placements
 *      under the *pre-sync* view — same zoom, same pan. `TimelineView`'s fit-on-new-content
 *      path is held off (`frozen`) until this is over. Without that, the clips would be
 *      re-laid-out under a new zoom in the same frame the hop starts, and the distance each
 *      one appears to travel would be a mix of "where the audio says it was" and "how far
 *      the camera moved" — which is not a thing anyone can read.
 *   2. **Hop.** Every clip drawn in both layouts is pushed back to its old position with a
 *      `transform`, then released. One transition, 450 ms, on the compositor.
 *   3. **Fit.** Only then does the view travel — one interpolated ~300 ms zoom/pan to the
 *      result's own fit, after which ordinary fit behaviour resumes.
 *
 * **Transform-based FLIP, and no DOM measurement.** A clip's `left`/`width` are inline and
 * recomputed on every pan and zoom frame, so a `transition: left` would be fighting the pan
 * loop for the same property — the two would take turns and the result would stutter
 * exactly when the operator grabbed it. `transform` is a separate property nothing else
 * writes. And the "First" half of FLIP is *arithmetic* (`timeline/hop.ts`), not
 * `getBoundingClientRect`: by the time anything can react to the change React has already
 * committed the new positions, so a DOM read would return the new layout. The old one only
 * exists as the previous render's data.
 *
 * **Reduced motion skips the work, not just the animation.** `styles.css` kills every
 * transition under `prefers-reduced-motion: reduce`, so a hop there would set a transform,
 * get no transition, and sit on the old position until a `transitionend` that never comes.
 * The gate is therefore at the top of the sequence: no transforms, no ghosts, no
 * interpolated fit — the layout lands final and correct, which it already is.
 *
 * **The user always wins.** Any pan, zoom or fit the operator asks for while this is
 * running cancels the whole sequence on the spot: every inline transform is dropped, the
 * clips snap to their true positions, and the view is left exactly where the operator put
 * it (`fittedSpan` is marked done so nothing snaps it back afterwards).
 */

/** How long a clip takes to travel. Long enough to read as movement rather than a cut.
 *  Must match `.clip--hop`'s transition duration in `styles.css`, which is where the
 *  browser reads it from — this copy exists only to size the safety net below. */
const HOP_MS = 450;

/** `transitionend` can be dropped — an interrupted transition, a clip scrolled out of the
 *  virtualization window mid-flight, a backgrounded tab. Nothing may be left wearing an
 *  inline transform because of it, so a timer finishes the job regardless. */
const HOP_SAFETY_MS = HOP_MS + 250;

/** The one smooth view move afterwards. */
const FIT_MS = 300;

/** How long a departing clip takes to fade out. Shorter than the hop: it is leaving, and
 *  the eye should be on the clips that are arriving. */
const FADE_MS = 260;

export const HOP_CLASS = "clip--hop";
export const FADE_CLASS = "clip--fade";
export const GHOST_CLASS = "clip--ghost";

/** On the section for the length of the clips' travel only — it relaxes the lane clipping
 *  so a clip can cross a track boundary (see `styles.css`). */
export const HOPPING_CLASS = "timeline--hopping";

/**
 * On the section for the WHOLE sequence, freeze through hop through fit: "this timeline is
 * moving under its own power right now".
 *
 * Real state, not a test hook, though it is what lets the browser tier wait for the view to
 * come to rest instead of sampling a tween (which is the one thing an animation test must
 * never do). It is also the honest answer to "is the timeline showing its final layout?",
 * which for ~750 ms after a sync lands is no.
 */
export const HOP_ATTR = "data-hop";

/**
 * True when the platform has NOT asked for reduced motion.
 *
 * Unknown counts as "reduce": if `matchMedia` is missing there is no way to ask, and the
 * safe answer to "may I animate?" without an answer is no.
 */
function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Everything one running hop has to be able to undo. */
interface HopRun {
  /** Clips currently wearing `HOP_CLASS` + an inline transform. */
  nodes: Set<HTMLElement>;
  timers: ReturnType<typeof setTimeout>[];
  raf: number | null;
  onTransitionEnd: ((e: TransitionEvent) => void) | null;
}

export interface HopHandle {
  /** True while the result is being drawn under the pre-sync view — the signal
   *  `TimelineView`'s measure effect reads to hold its fit back. */
  frozen: MutableRefObject<boolean>;
  /** Abandon any hop in flight and leave every clip on its true position. Called by every
   *  gesture that takes the view: pan, wheel, zoom buttons, fit, the scrollbar. */
  cancel: () => void;
}

export function useHop({
  tracks,
  view,
  outcome,
  contentSpanMs,
  bodyRef,
  sectionRef,
  ghostRef,
  setView,
  fittedSpan,
}: {
  /** The layout currently drawn — `TimelineView`'s per-device rows. */
  tracks: readonly HopTrack[];
  view: View;
  /** Identity is what matters: a new object here means a new run's result arrived. */
  outcome: unknown | null;
  contentSpanMs: number;
  bodyRef: RefObject<HTMLDivElement>;
  sectionRef: RefObject<HTMLElement>;
  /** The layer the fade ghosts are drawn into (`.timeline__ghosts`). */
  ghostRef: RefObject<HTMLDivElement>;
  setView: (update: (v: View) => View) => void;
  /** `TimelineView`'s "which span have I already fitted?" marker — the hop owns it while
   *  it is running, and hands it back set to the span it finished on. */
  fittedSpan: MutableRefObject<number | null>;
}): HopHandle {
  const frozen = useRef(false);
  const run = useRef<HopRun | null>(null);

  // The last committed layout + view, and the outcome that produced it. Read on the commit
  // where the outcome arrives; written on every commit, which is what makes it the state
  // "one frame ago" rather than "at some point earlier".
  const drawn = useRef<{ tracks: readonly HopTrack[]; view: View } | null>(null);
  const lastOutcome = useRef<unknown | null>(null);

  // Read inside rAF callbacks, which outlive the render that scheduled them.
  const viewRef = useRef(view);
  const spanRef = useRef(contentSpanMs);

  /** Strip a clip back to no transition and no transform, whatever state it was in. */
  const release = useCallback((node: HTMLElement) => {
    node.classList.remove(HOP_CLASS);
    node.style.transform = "";
    node.style.willChange = "";
  }, []);

  const cancel = useCallback(() => {
    const current = run.current;
    run.current = null;
    frozen.current = false;
    // Whatever the view is now is the view the operator gets to keep: mark this span
    // fitted so the measure effect does not snap it somewhere else on the next render.
    fittedSpan.current = spanRef.current;
    if (!current) return;
    for (const timer of current.timers) clearTimeout(timer);
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    for (const node of current.nodes) release(node);
    current.nodes.clear();
    if (current.onTransitionEnd && bodyRef.current) {
      bodyRef.current.removeEventListener("transitionend", current.onTransitionEnd);
    }
    sectionRef.current?.classList.remove(HOPPING_CLASS);
    sectionRef.current?.removeAttribute(HOP_ATTR);
    if (ghostRef.current) ghostRef.current.replaceChildren();
  }, [bodyRef, fittedSpan, ghostRef, release, sectionRef]);

  const start = useCallback(
    (from: { tracks: readonly HopTrack[]; view: View }, to: { tracks: readonly HopTrack[]; view: View }) => {
      const body = bodyRef.current;
      const section = sectionRef.current;
      if (!body || !section) return;

      const current: HopRun = { nodes: new Set(), timers: [], raf: null, onTransitionEnd: null };
      run.current = current;
      frozen.current = true;
      section.setAttribute(HOP_ATTR, "");

      // ---- The view move that comes last, defined first so `finish` can reach it -------
      const settle = () => {
        if (run.current !== current) return;
        run.current = null;
        frozen.current = false;
        fittedSpan.current = spanRef.current;
        section.removeAttribute(HOP_ATTR);
      };

      const startFit = () => {
        if (run.current !== current) return;
        const span = spanRef.current;
        const origin = viewRef.current;
        if (!(origin.widthPx > 0) || !(origin.pxPerMs > 0)) {
          settle();
          return;
        }
        const targetPxPerMs = fitPxPerMs(span, origin.widthPx);
        const t0 = performance.now();
        const step = (now: number) => {
          if (run.current !== current) return;
          const p = Math.min(1, (now - t0) / FIT_MS);
          // Ease out: most of the distance early, then a soft landing — the same shape the
          // clips' own cubic-bezier has, so the two moves read as one gesture.
          const eased = 1 - Math.pow(1 - p, 3);
          setView((v) => {
            // Zoom interpolates GEOMETRICALLY. Zoom is a ratio — halving and doubling are
            // the same size of step — and a linear ramp between two px/ms values crawls at
            // one end and lurches at the other whenever they differ by more than a little,
            // which after a sync they routinely do.
            const pxPerMs = origin.pxPerMs * Math.pow(targetPxPerMs / origin.pxPerMs, eased);
            const scrollMs = origin.scrollMs * (1 - eased);
            return { ...v, pxPerMs, scrollMs: clampScroll(scrollMs, pxPerMs, v.widthPx, span) };
          });
          if (p < 1) current.raf = requestAnimationFrame(step);
          else settle();
        };
        current.raf = requestAnimationFrame(step);
      };

      // ---- The hop itself -------------------------------------------------------------
      const deltas = hopDeltas(from.tracks, from.view, to.tracks, to.view);
      const exits = hopExits(from.tracks, from.view, to.tracks);

      // Address clips by their own `data-file` rather than by a selector built from a
      // path: a file name may contain anything a POSIX path may contain, quotes and
      // brackets included, and a hand-built attribute selector would be a parse error on
      // exactly the drops that are hardest to reproduce.
      const byFile = new Map<string, HTMLElement>();
      for (const el of body.querySelectorAll<HTMLElement>(".clip[data-file]")) {
        const file = el.dataset.file;
        if (file !== undefined) byFile.set(file, el);
      }

      for (const [file, delta] of deltas) {
        // A clip that did not move gets no transform, and therefore no `transitionend` to
        // wait for. Off-screen clips have no node at all (virtualization) — they simply
        // appear where they belong when they are scrolled to.
        if (delta.dx === 0 && delta.dy === 0) continue;
        const node = byFile.get(file);
        if (!node) continue;
        node.style.willChange = "transform";
        node.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
        current.nodes.add(node);
      }

      // Departing clips (unplaced, or removed): React has already taken their nodes out,
      // so what fades is a ghost drawn at the box the clip used to occupy.
      const ghosts = ghostRef.current;
      if (ghosts && exits.size > 0) {
        for (const [file, box] of exits) {
          const ghost = document.createElement("div");
          ghost.className = `clip clip--pre ${GHOST_CLASS}`;
          ghost.style.left = `${box.x}px`;
          ghost.style.top = `${box.y}px`;
          ghost.style.bottom = "auto";
          ghost.style.width = `${box.width}px`;
          ghost.style.height = `${CLIP_HEIGHT_PX}px`;
          ghost.dataset.file = file;
          // Decorative twice over: it is a copy of something that was already announced,
          // and it is on its way out.
          ghost.setAttribute("aria-hidden", "true");
          ghosts.append(ghost);
        }
      }

      // One forced reflow, here and nowhere else: the browser must observe the clips at
      // their old transforms before the transition class arrives, or it coalesces both
      // writes into one style recalculation and there is nothing to animate from.
      void body.offsetHeight;

      section.classList.add(HOPPING_CLASS);
      for (const node of current.nodes) {
        node.classList.add(HOP_CLASS);
        node.style.transform = "";
      }
      if (ghosts) {
        for (const ghost of Array.from(ghosts.children)) ghost.classList.add(FADE_CLASS);
      }

      const finish = () => {
        if (run.current !== current) return;
        for (const timer of current.timers) clearTimeout(timer);
        current.timers.length = 0;
        for (const node of current.nodes) release(node);
        current.nodes.clear();
        if (current.onTransitionEnd) {
          body.removeEventListener("transitionend", current.onTransitionEnd);
          current.onTransitionEnd = null;
        }
        section.classList.remove(HOPPING_CLASS);
        if (ghosts) ghosts.replaceChildren();
        startFit();
      };

      if (current.nodes.size === 0) {
        // Nothing moved (or nothing was on screen to move). The ghosts still need their
        // fade, but the view need not wait for it.
        current.timers.push(setTimeout(finish, ghosts && exits.size > 0 ? FADE_MS : 0));
        return;
      }

      // Fast path: finish as soon as the last clip has actually landed.
      const onTransitionEnd = (e: TransitionEvent) => {
        if (e.propertyName !== "transform") return;
        const node = e.target as HTMLElement;
        if (!current.nodes.has(node)) return;
        release(node);
        current.nodes.delete(node);
        if (current.nodes.size === 0) finish();
      };
      current.onTransitionEnd = onTransitionEnd;
      body.addEventListener("transitionend", onTransitionEnd);
      // …and the promise that it ends anyway.
      current.timers.push(setTimeout(finish, HOP_SAFETY_MS));
    },
    [bodyRef, fittedSpan, ghostRef, release, sectionRef, setView],
  );

  // Declared BEFORE `TimelineView`'s measure effect so it runs first in the same commit:
  // `frozen` has to be true before the fit path reads it, and both are layout effects in
  // one component, which React runs in declaration order.
  useLayoutEffect(() => {
    viewRef.current = view;
    spanRef.current = contentSpanMs;

    const previous = drawn.current;
    const previousOutcome = lastOutcome.current;
    drawn.current = { tracks, view };
    lastOutcome.current = outcome;

    // A hop is exactly the arrival of a NEW outcome over something that was already drawn.
    // Identity, not "is there one": a second sync replaces the object, and the reducer has
    // taken the old one away in between (`sync/start` moves to the syncing phase), so the
    // "before" this hops from is the pre-sync layout, both times.
    if (outcome === null || outcome === previousOutcome) return;
    // A whole hop could still be in flight from the previous outcome if the operator was
    // fast; it describes positions that no longer exist.
    if (run.current) cancel();
    if (!previous || previous.tracks.length === 0) return;
    if (!motionAllowed()) return;
    start(previous, { tracks, view });
  }, [tracks, view, outcome, contentSpanMs, cancel, start]);

  // Nothing may outlive the component: a timer that fires after unmount would touch
  // detached nodes, and a rAF would call `setView` on a gone tree.
  useEffect(() => cancel, [cancel]);

  // Stable, so the callbacks that cancel a hop (and the native wheel listener built from
  // them) are not rebuilt and rebound on every pan frame.
  return useMemo(() => ({ frozen, cancel }), [cancel]);
}
