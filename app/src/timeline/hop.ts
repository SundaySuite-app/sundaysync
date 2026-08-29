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
 *     `Track.tsx` sets each track's height to `max(1, rows.length) * laneHeight` and each
 *     lane's to `laneHeight`, so the stack is exactly determined by the row counts and the
 *     one pitch — which since D-091 is a per-render VALUE (`laneHeightFor`) threaded from
 *     `TimelineView` into `Track` and into `clipBoxes` alike, rather than a constant both
 *     of them import.
 *
 * Measuring would also be *wrong* here, not merely slower: the whole sequence depends on
 * reading the OLD positions after React has already committed the NEW ones. A DOM read at
 * that point returns the new layout. The old one only exists as the previous render's data,
 * which is what this module takes.
 *
 * The pixel rules below are the single source of truth for a clip box's geometry, vertical
 * and horizontal both: `TimelineView` calls `laneHeightFor` for the pitch it hands `Track`,
 * and `Clip` calls `clipDrawing` for the width it writes into its style. Nothing is
 * duplicated in `styles.css` any more — the padding that used to be there and that used to
 * silently floor a 3 px clip at 12.8 px now lives on `.clip__chrome`, inside the box rather
 * than around it (D-091) — and the numbers are kept honest by the ghost boxes, which are
 * positioned from here and sit right next to real clips positioned by the component.
 *
 * React-free and DOM-free like its neighbours (`geometry.ts`, `laneLayout.ts`,
 * `viewport.ts`, `sourceLayout.ts`), so the arithmetic that is easy to get quietly wrong is
 * the arithmetic that gets unit-tested.
 */

import { msToX, type TimelineView } from "./geometry";
import type { ClipSpan } from "./laneLayout";

/**
 * The floor for one sub-track lane — the px `.track__lane` is drawn at when the room is
 * full.
 *
 * **40 since V06-R2b (D-083)**, up from 34. The gutter carries two lines now (identity, and
 * `count · length ·` the analysis dot), and two lines of 11–13 px type do not fit in 34.
 *
 * **No longer THE pitch, since V06-G2 (D-091).** The review measured 45–79 % of the stage
 * sitting empty below the last row on every drop it looked at, the 386-clip wedding
 * included: 40 px is the right number for twenty rows in a laptop-sized frame and a waste of
 * a room for three. The pitch is a per-render VALUE now — {@link laneHeightFor} — and this
 * is its lower bound.
 */
export const LANE_MIN_PX = 40;

/**
 * …and its upper bound. A lane taller than this stops reading as a row of a timeline and
 * starts reading as a panel: the clip's own label is one line of 11 px type wherever it sits
 * in the box, so past ~90 px the extra pixels go entirely into empty wash above and below
 * the waveform. Three devices in a tall window hit this and stop growing, which is correct —
 * the answer to "too much room" is a lane that has taken all it can use, not a lane that
 * takes all there is.
 */
export const LANE_MAX_PX = 90;

/**
 * The pitch for THIS render: as tall as the rows can be made without the stage having to
 * scroll, inside {@link LANE_MIN_PX}…{@link LANE_MAX_PX}.
 *
 * **This function is the ONLY place the row pitch is decided (D-083, restated for D-091).**
 * Its result is threaded, as one number, from `TimelineView` into BOTH consumers: `Track`
 * writes it into the track's height (`max(1, rows) * lane`) and each lane's, and
 * {@link clipBoxes} sums the same value for the hop's y-arithmetic. Nothing anywhere may
 * state the pitch a second time — in particular no `min-height` on the gutter or the lane: a
 * lane the browser grew to fit a taller gutter would still be summed here at the threaded
 * value, and every clip below the first track would hop to a row it is not in. That is the
 * failure D-083 wrote the constant for, and turning the constant into a value does not make
 * it any less silent; it makes it *easier* to reach for a second opinion, which is why the
 * number has exactly one producer and is passed rather than recomputed.
 *
 * `availablePx` is the lane column's own height (the scrolling stage, ruler excluded).
 * Non-finite or non-positive — the frame has not been measured yet, which is the state of
 * the very first commit — falls back to the floor, so an unmeasured room draws exactly what
 * v0.6.0-beta.3 drew and then grows once the observer fires.
 */
export function laneHeightFor(rows: number, availablePx: number): number {
  if (!Number.isFinite(availablePx) || availablePx <= 0) return LANE_MIN_PX;
  if (!Number.isFinite(rows) || rows <= 0) return LANE_MIN_PX;
  const fair = Math.floor(availablePx / rows);
  return Math.min(LANE_MAX_PX, Math.max(LANE_MIN_PX, fair));
}

/** `.track`'s hairline (`.track + .track { border-top }`). Inside the box, since the sheet
 *  is `border-box` throughout — so it does not add to a track's height, it only pushes the
 *  lanes down by a pixel inside it. Every content track has one (the ruler track precedes
 *  them all), so it cancels in a delta and matters only to the absolute positions the fade
 *  ghosts are placed at. */
const TRACK_BORDER_PX = 1;

/** `.track__lane`'s own top hairline, inside the lane's height for the same reason. */
const LANE_BORDER_PX = 1;

/** `.clip`'s `top`/`bottom` inset inside its lane. */
const CLIP_INSET_PX = 3;

/** What `.clip` therefore measures vertically, at a given pitch — used to draw a fade ghost
 *  the same size as the clip it stands in for. Derived, exactly as `CLIP_HEIGHT_PX` was
 *  before D-091 made the pitch a value: lane − 7. */
export function clipHeightFor(laneHeightPx: number): number {
  return laneHeightPx - LANE_BORDER_PX - 2 * CLIP_INSET_PX;
}

/**
 * Narrower than this, a clip has no room to be a DRAWING — no border and wash and waveform
 * and label, just three or four pixels of chrome fighting each other — so it is drawn as a
 * {@link HAIRLINE_WIDTH_PX} tick in the full state colour instead (D-091).
 *
 * The old rule floored every clip at 3 px and let the box keep its padding, which is what
 * the V06 review measured going wrong: `.clip`'s `0 0.4rem` is 12.8 px on a `border-box`
 * sheet, so a clip DECLARED 3 px wide was LAID OUT 12.8 px wide, and at fit zoom on the
 * wedding 309 of 340 adjacent pairs overlapped — Playwright could aim at clip #3 and click
 * clip #2. The padding moved to `.clip__chrome`, which a hairline does not render, so a
 * hairline's box is exactly its declared width.
 */
export const CLIP_DRAWING_MIN_PX = 6;

/** What a hairline measures. Two device-independent pixels: one is a rounding error away
 *  from invisible on a fractional-DPR display, three is wide enough to start looking like a
 *  clip that lost its label. `Clip.tsx` and `clipBoxes` both go through
 *  {@link clipDrawing}, so a ghost and its clip can never disagree about a sliver. */
export const HAIRLINE_WIDTH_PX = 2;

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

/** How one clip's box is drawn horizontally — the answer {@link clipDrawing} gives, and the
 *  answer `Clip.tsx` renders. */
export interface ClipDrawing {
  /** Drawn width in CSS px. Never wider than the room before the next clip in the same
   *  lane; never narrower than a hairline unless the room itself is. */
  width: number;
  /** There is no room for a drawing: no padding, no label, no waveform — a tick. */
  hairline: boolean;
}

/**
 * A clip's drawn width, and whether it is wide enough to be a drawing at all (D-091).
 *
 * Two inputs, and the second is the whole point. `spanPx` is what the clip's own duration
 * asks for; `roomPx` is the distance from this clip's start to the NEXT clip's start in the
 * same lane (`Infinity` for the last clip in a row). **The declared start is sacred and the
 * width yields**: a clip is positioned by `msToX(startMs)` and that number is the app's
 * claim about when the camera rolled, so the box may be clipped short of the truth but may
 * never be moved off it, and may never be drawn across its neighbour's claim either.
 *
 * `stackClips` already guarantees `endMs <= next.startMs` inside a row, so in exact
 * arithmetic `spanPx <= roomPx` and the clamp does nothing. What it is for is the two FLOORS
 * that used to break that guarantee: the old 3 px minimum width, and — much worse, because
 * nothing in the code said it — `.clip`'s 12.8 px of `border-box` padding, which laid a box
 * out four times wider than the width written into its style attribute. At fit zoom on the
 * wedding the two of them put 309 of 340 adjacent pairs on top of one another.
 *
 * A clip whose neighbour starts at the same pixel gets a width of 0. That is not a clip
 * disappearing so much as it is two clips having asked for the same pixel: the box is still
 * in the DOM, still named, still reachable by keyboard and still counted, and one notch of
 * zoom gives it its pixel back. Drawing it anyway would put it on top of the neighbour,
 * which is the bug.
 */
export function clipDrawing(spanPx: number, roomPx: number): ClipDrawing {
  const room = Number.isFinite(roomPx) ? Math.max(0, roomPx) : Number.POSITIVE_INFINITY;
  // A NaN span (geometry that has not settled) must not smuggle a width through a `Math.min`.
  const natural = Number.isFinite(spanPx) && spanPx > 0 ? spanPx : 0;
  const drawn = Math.min(natural, room);
  // Below the threshold the box stops being a picture of a duration and becomes a MARK, so
  // it is drawn at the mark's width rather than at four or five pixels of nothing. The snap
  // from 6 px to 2 px on the way out is deliberate and is the honest reading: at five pixels
  // a clip's width no longer tells the operator anything about how long it is, and a row of
  // even ticks is countable where a row of ragged five-pixel stubs is not.
  if (drawn < CLIP_DRAWING_MIN_PX) return { width: Math.min(HAIRLINE_WIDTH_PX, room), hairline: true };
  return { width: drawn, hairline: false };
}

/** The room a clip has before the next one in its lane starts, in px — `Infinity` for the
 *  last clip in a row. Exported so `Track`/`Clip` and `clipBoxes` compute it the one way. */
export function roomBeforeNext(
  span: ClipSpan,
  next: ClipSpan | undefined,
  pxPerMs: number,
): number {
  if (next === undefined) return Number.POSITIVE_INFINITY;
  return (next.startMs - span.startMs) * pxPerMs;
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
  /** Drawn width, from {@link clipDrawing} exactly as the component draws it. */
  width: number;
  /** Drawn as a tick rather than as a drawing — see {@link clipDrawing}. */
  hairline: boolean;
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
  laneHeightPx: number,
): Map<string, ClipBox> {
  const boxes = new Map<string, ClipBox>();
  let trackTop = 0;
  for (const track of tracks) {
    for (let row = 0; row < track.rows.length; row++) {
      const y =
        trackTop + TRACK_BORDER_PX + row * laneHeightPx + LANE_BORDER_PX + CLIP_INSET_PX;
      const spans = track.rows[row];
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        // `stackClips` sorted the row by `startMs`, so the next entry IS the next clip in
        // time — the same neighbour `Track` hands `Clip`, so the ghost drawn from here and
        // the box drawn by the component are one number.
        const draw = clipDrawing(
          (span.endMs - span.startMs) * view.pxPerMs,
          roomBeforeNext(span, spans[i + 1], view.pxPerMs),
        );
        boxes.set(span.file, { x: msToX(span.startMs, view), y, ...draw });
      }
    }
    // A device with nothing on it still occupies one lane (§7.5's "a camera that synced
    // nothing must be visible"), which is why this is `max(1, …)` and not `rows.length`.
    trackTop += Math.max(1, track.rows.length) * laneHeightPx;
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
  oldLaneHeightPx: number,
  newTracks: readonly HopTrack[],
  newView: TimelineView,
  newLaneHeightPx: number,
): Map<string, HopDelta> {
  const before = clipBoxes(oldTracks, oldView, oldLaneHeightPx);
  const after = clipBoxes(newTracks, newView, newLaneHeightPx);
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
  oldLaneHeightPx: number,
  newTracks: readonly HopTrack[],
): Map<string, ClipBox> {
  const before = clipBoxes(oldTracks, oldView, oldLaneHeightPx);
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

/** And vertically. Deliberately much smaller: the tightest lane is `LANE_MIN_PX` and a clip
 *  in it is 33 px, so ±3 px is a shiver inside the lane rather than a clip climbing out of
 *  it — and a lane that has grown only gives it more room to shiver in. */
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
 * at hairline width, and a box that narrow wandering ±8 px travels further than its own
 * width and back inside 140 ms — which the eye does not read as "finding itself", it reads
 * as flicker, or as a clip that jumped somewhere else and returned. Capping the horizontal
 * reach at the clip's own width keeps the wander proportional to the thing wandering: a wide
 * clip drifts a comfortable 8 px, a sliver shivers.
 *
 * **Since D-091 `widthPx` is the width the operator actually sees**, and the note that used
 * to stand here — explaining that the cap was conservative because `.clip`'s `border-box`
 * padding secretly floored a 3 px box at 12.8 px — describes a stylesheet the app no longer
 * has. The padding is on `.clip__chrome` now, which a hairline does not render, so the
 * declared width IS the laid-out width and the cap is exact rather than merely safe.
 * `HOP_MIN_JITTER_X_PX` is what keeps a 2 px tick's shiver visible at all.
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
