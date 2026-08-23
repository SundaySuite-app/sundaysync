/**
 * The hop: where every clip box IS, and how far it has to travel when the sync lands
 * (v0.4, D-063).
 *
 * The owner's words for this stage were «når man klikker sync, så *hopper* filene på plass
 * når de får en match — det skal være veldig smooth». A hop is a FLIP animation: draw the
 * new layout, offset every surviving box back to where it used to be, then let one
 * transition carry it forward. The usual way to get the "First" half of that is to measure
 * the DOM before the change (`getBoundingClientRect` on every clip). This module exists so
 * that nothing is ever measured.
 *
 * It can be arithmetic because both layouts are already fully described by data the
 * timeline has in hand:
 *
 *   - **x** is `msToX(span.startMs, view)` — the very expression `Clip.tsx` puts in its
 *     inline `left`. Same function, same view, so the number this module computes and the
 *     number the browser lays out at are the same number by construction, not by luck.
 *   - **y** is a sum of track heights above the clip plus its row inside its own track.
 *     `Track.tsx` sets each track's height to `max(1, rows.length) * LANE_HEIGHT_PX` and
 *     each lane's to `LANE_HEIGHT_PX`, so the stack is exactly determined by the row counts.
 *
 * Measuring would also be *wrong* here, not merely slower: the whole sequence depends on
 * reading the OLD positions after React has already committed the NEW ones. A DOM read at
 * that point returns the new layout. The old one only exists as the previous render's data,
 * which is what this module takes.
 *
 * The pixel constants below are the single source of truth for the vertical geometry:
 * `TimelineView` imports `LANE_HEIGHT_PX` for the height it hands `Track`, and `Clip`
 * imports `MIN_CLIP_WIDTH_PX`. They are duplicated in `styles.css` — that is unavoidable,
 * a stylesheet cannot import — and the two are kept honest by the ghost boxes, which are
 * positioned from these numbers and sit right next to real clips positioned by the CSS.
 *
 * React-free and DOM-free like its neighbours (`geometry.ts`, `laneLayout.ts`,
 * `viewport.ts`, `sourceLayout.ts`), so the arithmetic that is easy to get quietly wrong is
 * the arithmetic that gets unit-tested.
 */

import { msToX, type TimelineView } from "./geometry";
import type { ClipSpan } from "./laneLayout";

/**
 * Height of one sub-track lane — the px `.track__lane` is drawn at.
 *
 * **40 since V06-R2b (D-083)**, up from 34. The gutter carries two lines now (identity, and
 * `count · length ·` the analysis dot), and two lines of 11–13 px type do not fit in 34.
 *
 * This constant is the ONLY place the row pitch is stated. `Track.tsx` sets both the track's
 * height (`max(1, rows) * laneHeight`) and each lane's height from it, `TimelineView` hands
 * it down, `clipBoxes` below sums the same number, and `useHop`'s ghosts are drawn from
 * `CLIP_HEIGHT_PX`, which derives from it. Nothing anywhere may state the pitch a second
 * time — in particular no `min-height` on the gutter or the lane: a lane the browser grew to
 * fit a taller gutter would still be summed here at this value, and every clip below the
 * first track would hop to a row it is not in. The stylesheet's own two mirrors
 * (`.lane__empty`'s `line-height`, and nothing else) are the unavoidable exceptions, and
 * they are cosmetic rather than load-bearing.
 */
export const LANE_HEIGHT_PX = 40;

/** `.track`'s hairline (`.track + .track { border-top }`). Inside the box, since the sheet
 *  is `border-box` throughout — so it does not add to a track's height, it only pushes the
 *  lanes down by a pixel inside it. Every content track has one (the ruler track precedes
 *  them all), so it cancels in a delta and matters only to the absolute positions the fade
 *  ghosts are placed at. */
const TRACK_BORDER_PX = 1;

/** `.track__lane`'s own top hairline, inside its 40 px for the same reason. */
const LANE_BORDER_PX = 1;

/** `.clip`'s `top`/`bottom` inset inside its lane. */
const CLIP_INSET_PX = 3;

/** What `.clip` therefore measures vertically — used to draw a fade ghost the same size as
 *  the clip it stands in for. */
export const CLIP_HEIGHT_PX = LANE_HEIGHT_PX - LANE_BORDER_PX - 2 * CLIP_INSET_PX;

/** Narrower than this and the box is a tick mark, not a clip — but still there. `Clip.tsx`
 *  imports this so a ghost and its clip can never disagree about a sliver's width. */
export const MIN_CLIP_WIDTH_PX = 3;

/**
 * One device's drawn row, as far as this module is concerned: its clips, already packed
 * into sub-track rows by `stackClips`.
 *
 * Structurally a subset of what `TimelineView` builds (`{ device, rows }`), on purpose —
 * the vertical arithmetic depends on row COUNTS and nothing else, and a module that cannot
 * see the device cannot accidentally start caring which one it is.
 */
export interface HopTrack {
  rows: readonly (readonly ClipSpan[])[];
}

/** Where one clip's box sits, in the same pixels `Clip.tsx` writes into `left`/`width`. */
export interface ClipBox {
  /** Left edge, from `msToX` — may be negative or past the viewport; the caller clips. */
  x: number;
  /** Top edge, measured from the top of the FIRST CONTENT TRACK's border box, i.e. with
   *  the ruler track excluded. The ruler has a fixed height that is the same in both
   *  layouts, so leaving it out costs nothing in a delta and spares this module a constant
   *  it would have to keep in step with `--tl-ruler-h`. */
  y: number;
  /** Drawn width, floored at `MIN_CLIP_WIDTH_PX` exactly as the component floors it. */
  width: number;
}

/** How far a clip has to be pushed back to start the hop where it used to be. */
export interface HopDelta {
  /** OLD x minus NEW x. Apply as `transform: translate(dx, dy)` on the newly laid-out
   *  node and it sits on its old position; transition that transform away and it hops. */
  dx: number;
  dy: number;
}

/**
 * Every clip's box in one layout.
 *
 * A file appearing on two tracks at once is not a thing the layout can produce (each file
 * has exactly one effective device, and `stackClips` only ever moves a clip between rows of
 * the same track) — if one somehow did, the last one drawn wins, which is also what the DOM
 * would end up doing with two nodes carrying the same `data-file`.
 */
export function clipBoxes(
  tracks: readonly HopTrack[],
  view: TimelineView,
): Map<string, ClipBox> {
  const boxes = new Map<string, ClipBox>();
  let trackTop = 0;
  for (const track of tracks) {
    for (let row = 0; row < track.rows.length; row++) {
      const y =
        trackTop + TRACK_BORDER_PX + row * LANE_HEIGHT_PX + LANE_BORDER_PX + CLIP_INSET_PX;
      for (const span of track.rows[row]) {
        boxes.set(span.file, {
          x: msToX(span.startMs, view),
          y,
          width: Math.max(MIN_CLIP_WIDTH_PX, (span.endMs - span.startMs) * view.pxPerMs),
        });
      }
    }
    // A device with nothing on it still occupies one lane (§7.5's "a camera that synced
    // nothing must be visible"), which is why this is `max(1, …)` and not `rows.length`.
    trackTop += Math.max(1, track.rows.length) * LANE_HEIGHT_PX;
  }
  return boxes;
}

/**
 * The FLIP deltas: for every file drawn in BOTH layouts, old position minus new.
 *
 * Files on only one side are absent from the result rather than carrying a delta of their
 * own — an arriving clip has no "before" to hop from, and a departing one has no node left
 * to hop with (see `hopExits`, which is what those get instead).
 *
 * A file that did not move is present with `{ dx: 0, dy: 0 }`. "Drawn in both layouts" and
 * "moved" are different questions and the caller asks them separately: the orchestration
 * skips the zeroes so they never get a transition to wait on, while a test asserting that a
 * clip stayed put wants to see the zero rather than an absence it would have to interpret.
 *
 * The two views are separate parameters because they need not be the same — but in the one
 * caller they are, deliberately: the result is rendered under the pre-sync view (frozen),
 * so the deltas describe movement on a stationary canvas and not movement mixed with a
 * zoom. See D-063.
 */
export function hopDeltas(
  oldTracks: readonly HopTrack[],
  oldView: TimelineView,
  newTracks: readonly HopTrack[],
  newView: TimelineView,
): Map<string, HopDelta> {
  const before = clipBoxes(oldTracks, oldView);
  const after = clipBoxes(newTracks, newView);
  const deltas = new Map<string, HopDelta>();
  for (const [file, box] of after) {
    const was = before.get(file);
    if (was === undefined) continue;
    deltas.set(file, { dx: was.x - box.x, dy: was.y - box.y });
  }
  return deltas;
}

/**
 * The boxes of files the new layout no longer draws — a clip the sync could not place, or
 * one the operator removed. React has already taken their nodes out of the DOM by the time
 * anything can react to the change, so they cannot be faded in place; the caller draws a
 * ghost at each of these boxes and fades that instead.
 */
export function hopExits(
  oldTracks: readonly HopTrack[],
  oldView: TimelineView,
  newTracks: readonly HopTrack[],
): Map<string, ClipBox> {
  const before = clipBoxes(oldTracks, oldView);
  const survivors = new Set<string>();
  for (const track of newTracks) {
    for (const row of track.rows) for (const span of row) survivors.add(span.file);
  }
  const exits = new Map<string, ClipBox>();
  for (const [file, box] of before) if (!survivors.has(file)) exits.set(file, box);
  return exits;
}

/* ── The shuffle, the travel and the bounce (V06, D-090) ────────────────────────────────
 *
 * The owner watched v0.4's hop land and asked for a different number: «ting hopper litt
 * rundt på tidslinjen og spretter på plassen hvor de skal være, for så å bli grønne». Three
 * things, in that order — a short wander, a travel that overshoots and springs back, and the
 * green arriving with the landing rather than being there all along.
 *
 * What lives here is the part of that which is arithmetic: *how long* each clip waits before
 * it starts, and *how far* it wanders while it does. The motion itself is one CSS keyframe
 * animation (`styles.css`), parameterised by five custom properties `useHop` writes on each
 * node — so 386 clips cost 386 style writes and nothing per frame, and the whole number runs
 * on the compositor.
 *
 * **Seeded, never `Math.random()`.** Each clip's delay and wander are a pure function of its
 * own file path. Two reasons, and the second is the one that mattered: a re-render mid-flight
 * would otherwise re-roll a clip's numbers and jerk it sideways, and a spec cannot assert a
 * distribution it cannot reproduce. The same drop choreographs identically on every machine
 * and every run.
 */

/** How long ONE clip's whole number takes, delay excluded: wander, travel, overshoot,
 *  spring-back. Mirrored in `styles.css` as `.clip--hop`'s `animation-duration`, which is
 *  where the browser reads it from — this copy sizes the safety net and the band's hold. */
export const HOP_TRAVEL_MS = 800;

/** The widest start delay any clip can draw. Small enough that the timeline reads as one
 *  event rather than as a queue, large enough that the landings arrive as a wave instead of
 *  as a single clack. */
export const HOP_MAX_DELAY_MS = 250;

/** Wall-clock length of the whole number, from the outcome landing to the last clip coming
 *  to rest: the longest delay anyone can draw, plus one clip's travel. ≈1.05 s.
 *
 *  Read by `useHop` (its own backstop) and, through it, by `App` (the progress band's hold,
 *  D-082) — the band must stay for the WHOLE number, and one constant is what keeps the two
 *  from drifting apart. */
export const HOP_TOTAL_MS = HOP_MAX_DELAY_MS + HOP_TRAVEL_MS;

/** How far a clip may wander sideways while it «finner seg selv», before the clip's own
 *  width is allowed to have an opinion (see `hopChoreography`). */
export const HOP_JITTER_X_PX = 8;

/** And vertically. Deliberately much smaller: a lane is 40 px and a clip 33 of them, so
 *  ±3 px is a shiver inside the lane rather than a clip climbing out of it. */
export const HOP_JITTER_Y_PX = 3;

/** The floor the width cap may not go below — a 3 px sliver still has to visibly move. */
export const HOP_MIN_JITTER_X_PX = 2;

/** What one clip does while everyone else is doing it too. */
export interface HopChoreography {
  /** ms before this clip starts, in `[0, HOP_MAX_DELAY_MS]`. */
  delayMs: number;
  /** The wander, in px, relative to the clip's OLD position. Signed; never zero. */
  jx: number;
  jy: number;
}

/**
 * FNV-1a over the file path — a hash, not a checksum: all that is asked of it is that two
 * neighbouring paths (`C0001.MP4`, `C0002.MP4`, which is what a camera card actually looks
 * like) land far apart, so a card's clips do not all draw the same delay and move as a block.
 */
function hashFile(file: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) {
    h ^= file.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — 32 bits of state, four operations, and a good enough spread for four draws
 *  per clip. Nothing here is cryptographic and nothing here pretends to be. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A signed wander of at least 40 % of `reach`, so a clip that drew a small number still
 * visibly moves — a "random" wander that can come out at 0.2 px is a clip standing still
 * while its neighbours dance, which reads as a bug rather than as variety.
 *
 * Rounded to a tenth of a pixel: enough resolution that no two clips look aligned, few
 * enough digits that the inline custom property a spec reads back is a short string.
 */
function signedReach(magnitude: number, sign: number, reach: number): number {
  const distance = reach * (0.4 + 0.6 * magnitude);
  return Math.round((sign < 0.5 ? -distance : distance) * 10) / 10;
}

/**
 * One clip's delay and wander, from its path and its drawn width.
 *
 * **The width cap is the whole reason `widthPx` is a parameter.** A wedding draws 386 clips
 * at `MIN_CLIP_WIDTH_PX`, and a box that narrow wandering ±8 px travels further than its own
 * width and back inside 140 ms — which the eye does not read as "finding itself", it reads
 * as flicker, or as a clip that jumped somewhere else and returned. Capping the horizontal
 * reach at the clip's own width keeps the wander proportional to the thing wandering: a wide
 * clip drifts a comfortable 8 px, a sliver shivers.
 *
 * The cap is deliberately a little conservative, and it is worth writing down why rather
 * than "fixing" it later. `widthPx` is the width this module computes and `Clip.tsx` writes
 * into `style.width` — but the box the operator actually sees at that setting measures about
 * 12.8 px, because `.clip`'s horizontal padding is wider than 3 px and the sheet is
 * `border-box`, so the padding sets a floor the declared width cannot go under. Reaching for
 * the drawn number would mean this module knowing a padding derived from the root font size,
 * which is exactly the kind of dependency the rest of the file refuses; and the error is in
 * the safe direction — a sliver shivering by 3 px of a 12.8 px box is legible (it was looked
 * at, at 24 clips and one frame per 100 ms), where the same box lurching by 8 is not.
 *
 * The vertical reach is not capped by anything — every clip is the same height, so there is
 * nothing for it to be out of proportion with.
 *
 * Pure and seeded: same file, same width, same numbers, forever.
 */
export function hopChoreography(file: string, widthPx: number): HopChoreography {
  const random = mulberry32(hashFile(file));
  const delayMs = Math.round(random() * HOP_MAX_DELAY_MS);
  const reachX = Math.max(HOP_MIN_JITTER_X_PX, Math.min(HOP_JITTER_X_PX, widthPx));
  const jx = signedReach(random(), random(), reachX);
  const jy = signedReach(random(), random(), HOP_JITTER_Y_PX);
  return { delayMs, jx, jy };
}
