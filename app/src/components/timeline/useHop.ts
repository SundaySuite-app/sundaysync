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
import {
  CLIP_HEIGHT_PX,
  HOP_TOTAL_MS,
  clipBoxes,
  hopChoreography,
  hopDeltas,
  hopExits,
  type HopTrack,
} from "../../timeline/hop";
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
 *   2. **Hop.** Every clip drawn in both layouts is pushed back to its old position and
 *      handed one keyframe animation. On the compositor, ~1.05 s end to end.
 *   3. **Fit.** Only then does the view travel — one interpolated ~300 ms zoom/pan to the
 *      result's own fit, after which ordinary fit behaviour resumes.
 *
 * ## What step 2 became in V06 (D-090)
 *
 * The owner watched v0.4's hop and asked for a livelier number: «ting hopper litt rundt på
 * tidslinjen og spretter på plassen hvor de skal være, for så å bli grønne». Three owner
 * choices, all of them visible in the code below:
 *
 *   - **Shuffle, then bounce.** Each clip wanders a little around its old position before it
 *     sets off, then travels PAST its target and springs back onto it. One `@keyframes`
 *     covers all of it (`styles.css`), parameterised per clip by five custom properties
 *     written here — one animation and not a chain, so there is no seam to mis-schedule and
 *     no `animationend` to hand off at.
 *   - **Green on landing.** A clip wears `TRAVELLING_CLASS` for exactly as long as its own
 *     animation runs, which paints it blue; the class comes off at that clip's
 *     `animationend`, and the clip is green from that instant. Green is the engine's claim,
 *     and a clip still in the air has not landed anywhere for the engine to stand behind.
 *   - **A wave, not a queue.** Every clip draws its own 0–250 ms start delay, so the
 *     landings — and therefore the greens — arrive spread across the timeline. Seeded from
 *     the file path (`timeline/hop.ts`), never `Math.random()`: a re-render mid-flight must
 *     not re-roll a clip's numbers, and a spec cannot assert a distribution it cannot
 *     reproduce.
 *
 * A clip whose delta is ZERO takes part too. It is the same one decision as the green: the
 * moment is «hele tidslinja finner seg selv», and one box sitting perfectly still and
 * already green in the middle of that reads as a clip that failed rather than as a clip that
 * happened not to move.
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
 * transition and animation under `prefers-reduced-motion: reduce`, so a hop there would set
 * an offset, get no animation, and sit on the old position — blue — until an `animationend`
 * that never comes. The gate is therefore at the top of the sequence: no offsets, no
 * travelling class, no ghosts, no interpolated fit — the layout lands final, green and
 * correct, which it already is.
 *
 * **The user always wins.** Any pan, zoom or fit the operator asks for while this is
 * running cancels the whole sequence on the spot: every animation and every offset is
 * dropped, the clips snap to their true positions — GREEN, all of them, in the same frame —
 * and the view is left exactly where the operator put it (`fittedSpan` is marked done so
 * nothing snaps it back afterwards). A cancelled hop is a finished hop as far as the colour
 * is concerned: the engine's answer is in, whether or not anyone watched it arrive.
 */

/** The whole number's wall-clock length: the widest start delay plus one clip's travel.
 *  Stated once, in `timeline/hop.ts`, alongside the arithmetic that produces the delays —
 *  and mirrored in `styles.css`, which is where the browser actually reads the duration
 *  from. Re-exported here because `useHop` is the module App already imports the hop's
 *  timings from, and a second import path is a second thing to keep in step. */
export { HOP_TOTAL_MS } from "../../timeline/hop";

/** `animationend` can be dropped — a clip scrolled out of the virtualization window
 *  mid-flight, a backgrounded tab, a re-render that replaced the node. Nothing may be left
 *  wearing an offset or the travelling blue because of it, so a timer finishes the job
 *  regardless.
 *
 *  Exported since V06-R1 (D-082): App holds the progress band open across the hop and needs
 *  the same backstop, sized from the same number rather than from a second guess. Since
 *  D-090 the number it is sized from is `HOP_TOTAL_MS`, so the band grew with the animation
 *  rather than having to be re-tuned beside it. */
export const HOP_SAFETY_MS = HOP_TOTAL_MS + 250;

/** The one smooth view move afterwards. */
const FIT_MS = 300;

/** How long a departing clip takes to leave: `.clip--fade`'s 150 ms delay plus its 260 ms
 *  fade (D-090). The delay is so the survivors' shuffle is legible before anything vanishes;
 *  this copy only sizes the timer for the case where nothing else is moving. */
const FADE_MS = 150 + 260;

/** Carries the animation. Kept under its v0.4 name: it is still "this clip is doing the
 *  hop", and everything that watches the timeline move — specs included — already says so. */
export const HOP_CLASS = "clip--hop";

/** Carries the COLOUR, and only the colour (D-090): blue while travelling, off at the
 *  landing. A separate class from `HOP_CLASS` because they answer separate questions — "is
 *  this clip moving?" and "has the engine's answer arrived for it?" — and because the
 *  reduced-motion path has to be able to state that neither is ever applied. */
export const TRAVELLING_CLASS = "clip--travelling";

export const FADE_CLASS = "clip--fade";
export const GHOST_CLASS = "clip--ghost";

/** The `@keyframes` name in `styles.css`. The delegated `animationend` listener filters on
 *  it: the ghosts' own fade animation bubbles through the same node. */
const HOP_ANIMATION = "clip-shuffle-bounce";

/** The five properties `styles.css` reads the number's shape out of. Listed once so
 *  `release` cannot forget one and leave a clip carrying a stale delta into the next hop. */
const HOP_PROPS = ["--hop-dx", "--hop-dy", "--hop-jx", "--hop-jy", "--hop-delay"] as const;

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
 * which for ~1.35 s after a sync lands is no (D-090: the number, then the fit).
 */
export const HOP_ATTR = "data-hop";

/**
 * True when the platform has NOT asked for reduced motion.
 *
 * Unknown counts as "reduce": if `matchMedia` is missing there is no way to ask, and the
 * safe answer to "may I animate?" without an answer is no.
 */
export function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Everything one running hop has to be able to undo. */
interface HopRun {
  /** Clips still in the air: wearing `HOP_CLASS` + `TRAVELLING_CLASS` + the five custom
   *  properties. A clip leaves this set at its own `animationend`, so the set's size IS the
   *  outstanding count, and its emptying is «the last clip has landed». */
  nodes: Set<HTMLElement>;
  timers: ReturnType<typeof setTimeout>[];
  raf: number | null;
  onAnimationEnd: ((e: AnimationEvent) => void) | null;
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
  onSettled,
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
  /**
   * The timeline has come to rest (V06-R1, D-082) — fired from BOTH endings the sequence
   * has: `settle()` (the fit finished on its own) and `cancel()` (the operator took the
   * view, or the component went away). Whoever is waiting on the hop is waiting on "is it
   * still moving?", and a cancelled hop answers that question exactly as much as a finished
   * one does.
   *
   * Held in a ref rather than taken as a dependency: `cancel` is a dependency of `start`,
   * which is a dependency of the layout effect that decides whether to hop at all. A
   * caller's inline callback would re-identify all three on every render of the app.
   */
  onSettled?: () => void;
}): HopHandle {
  const frozen = useRef(false);
  const run = useRef<HopRun | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  // The last committed layout + view, and the outcome that produced it. Read on the commit
  // where the outcome arrives; written on every commit, which is what makes it the state
  // "one frame ago" rather than "at some point earlier".
  const drawn = useRef<{ tracks: readonly HopTrack[]; view: View } | null>(null);
  const lastOutcome = useRef<unknown | null>(null);

  // Read inside rAF callbacks, which outlive the render that scheduled them.
  const viewRef = useRef(view);
  const spanRef = useRef(contentSpanMs);

  /**
   * Strip a clip back to no animation, no offset and no travelling blue, whatever state it
   * was in — which is also, and not incidentally, the moment it turns green. Every ending
   * the sequence has goes through here: a clip's own `animationend`, the safety timer, and
   * every gesture that cancels. There is therefore exactly one way for a clip to land, and
   * it lands the same way whether the number finished or the operator interrupted it.
   */
  const release = useCallback((node: HTMLElement) => {
    node.classList.remove(HOP_CLASS, TRAVELLING_CLASS);
    for (const prop of HOP_PROPS) node.style.removeProperty(prop);
    node.style.willChange = "";
  }, []);

  const cancel = useCallback(() => {
    const current = run.current;
    run.current = null;
    frozen.current = false;
    settledRef.current?.();
    // Whatever the view is now is the view the operator gets to keep: mark this span
    // fitted so the measure effect does not snap it somewhere else on the next render.
    fittedSpan.current = spanRef.current;
    if (!current) return;
    for (const timer of current.timers) clearTimeout(timer);
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    for (const node of current.nodes) release(node);
    current.nodes.clear();
    if (current.onAnimationEnd && bodyRef.current) {
      bodyRef.current.removeEventListener("animationend", current.onAnimationEnd);
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

      const current: HopRun = { nodes: new Set(), timers: [], raf: null, onAnimationEnd: null };
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
        settledRef.current?.();
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
      // The clips' DRAWN widths, under the frozen view they are about to be animated in.
      // Arithmetic, not `offsetWidth`: reading a width off a node inside the same loop that
      // writes its custom properties would interleave a layout read with a style write once
      // per clip, which on a 386-file wedding is 386 forced reflows in one frame.
      const widths = clipBoxes(to.tracks, to.view);

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
        // Off-screen clips have no node at all (virtualization) — they simply appear where
        // they belong, green, when they are scrolled to.
        //
        // A clip whose delta is ZERO still takes part (D-090). It has no travel to make, so
        // what it does is shuffle in place and go green with everyone else — which is the
        // owner's number: the whole timeline finds itself at once. Skipping it, as v0.4 did,
        // would leave one already-green box standing perfectly still in the middle of the
        // wave, and the eye reads that as the clip that went wrong.
        const node = byFile.get(file);
        if (!node) continue;
        const choreography = hopChoreography(file, widths.get(file)?.width ?? 0);
        node.style.willChange = "transform";
        // FLIP: the node is RENDERED at its solved position, so this offset is what puts it
        // back on its old one. `styles.css` animates from here to `translate(0, 0)`, by way
        // of the wander and the overshoot.
        node.style.setProperty("--hop-dx", `${delta.dx}px`);
        node.style.setProperty("--hop-dy", `${delta.dy}px`);
        node.style.setProperty("--hop-jx", `${choreography.jx}px`);
        node.style.setProperty("--hop-jy", `${choreography.jy}px`);
        node.style.setProperty("--hop-delay", `${choreography.delayMs}ms`);
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

      // No forced reflow anywhere in here, and that is a change worth stating: v0.4's hop
      // was a TRANSITION, which has to be primed — the browser must observe the old value
      // before the new one arrives or it coalesces both writes and there is nothing to
      // animate from. An ANIMATION carries both ends in its own keyframes and needs no such
      // ceremony, and the ghosts' fade became an animation for the same reason (D-090). So
      // the whole sequence is now style writes only: nothing here reads layout.
      section.classList.add(HOPPING_CLASS);
      for (const node of current.nodes) node.classList.add(HOP_CLASS, TRAVELLING_CLASS);
      if (ghosts) {
        for (const ghost of Array.from(ghosts.children)) ghost.classList.add(FADE_CLASS);
      }

      const finish = () => {
        if (run.current !== current) return;
        for (const timer of current.timers) clearTimeout(timer);
        current.timers.length = 0;
        for (const node of current.nodes) release(node);
        current.nodes.clear();
        if (current.onAnimationEnd) {
          body.removeEventListener("animationend", current.onAnimationEnd);
          current.onAnimationEnd = null;
        }
        section.classList.remove(HOPPING_CLASS);
        if (ghosts) ghosts.replaceChildren();
        startFit();
      };

      if (current.nodes.size === 0) {
        // No surviving clip has a node to animate — every one of them is outside the
        // virtualization window, or the run placed nothing that was here before. The ghosts
        // still need their fade, but the view need not wait for it.
        current.timers.push(setTimeout(finish, ghosts && exits.size > 0 ? FADE_MS : 0));
        return;
      }

      // ONE listener for every clip, delegated on the body (D-090) — 386 clips would
      // otherwise mean 386 listeners bound and unbound inside one commit. The filter on
      // `animationName` is not defensive tidiness: the ghosts' own fade is an animation in
      // the same subtree and bubbles through this very node.
      //
      // This is also where the GREEN happens. A clip leaves the outstanding set at its own
      // `animationend` and `release` takes its blue off in the same statement, so «bli
      // grønne» is not a separate effect to keep in step with the motion — it IS the end of
      // the motion, per clip. The staggered delays turn that into the wave.
      const onAnimationEnd = (e: AnimationEvent) => {
        if (e.animationName !== HOP_ANIMATION) return;
        const node = e.target as HTMLElement;
        if (!current.nodes.has(node)) return;
        release(node);
        current.nodes.delete(node);
        if (current.nodes.size === 0) finish();
      };
      current.onAnimationEnd = onAnimationEnd;
      body.addEventListener("animationend", onAnimationEnd);
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
