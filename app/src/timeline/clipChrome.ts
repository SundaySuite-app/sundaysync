/**
 * What actually fits inside a clip box — V05-W1, D-065.
 *
 * A pure width rule, in the style of `geometry.ts`/`hop.ts` and for the same reason: the
 * question "is there room for the filename, and for the status, and in which form" has
 * exact answers with exact thresholds, and answering it inside a component means the
 * answer is only ever checked by looking at one.
 *
 * The bug it exists for: a 386-file wedding at fit zoom draws clips a few pixels wide, and
 * every one of them was rendering its filename AND a «Bygg bølgeform på nytt» button, both
 * absolutely positioned, both inside a box narrower than either. Nothing was legible and
 * the button could not be aimed at. Layout alone would not have fixed it (two children in
 * one 3 px flex row are still two children in a 3 px row); a width rule alone would not
 * have either (the two were drawn on top of each other regardless of width). Both halves
 * are in D-065, and this is the second one.
 *
 * The rationing is of PIXELS only. Whatever this drops from the box stays in the DOM's
 * accessible surface — the clip's own `aria-label` still names the file, and a status that
 * shrinks to an icon keeps the full string as its `aria-label` and the engine's detail in
 * its `title`. Nothing is hidden from a screen reader; things are hidden from a 3 px box,
 * which cannot show them anyway.
 */

/**
 * What the clip has to say beside its name.
 *
 * - `none` — nothing; the waveform is drawing or already drawn.
 * - `control` — something to press (rebuild / busy-retry). The operator cannot act if it
 *   is not there, so it is the LAST thing to go and the first to get an abbreviated form.
 * - `info` — something to read (analysing, unavailable). There is nothing to press, so it
 *   is worth exactly the pixels it can have without costing the filename, and no more.
 */
export type ClipStatusKind = "none" | "control" | "info";

export interface ClipChrome {
  /** `ellipsis`: draw the filename, truncated with an ellipsis if it does not fit. */
  name: "none" | "ellipsis";
  status: "none" | "icon" | "text";
}

/** Below this a filename is a smear, not a name — an initial and a half. */
export const NAME_MIN_PX = 30;

/** A square-ish tap target with a glyph in it. The floor for a control that must remain
 *  aimable; below it there is nothing honest to draw. */
export const STATUS_ICON_MIN_PX = 22;

/** What the longest of the status strings needs at the clip font size («Bygg bølgeform på
 *  nytt» / «Bølgeform utilgjengelig») before it starts truncating into nonsense. */
export const STATUS_TEXT_MIN_PX = 150;

/** The gap between the name and the status in `.clip__chrome`'s flex row. Part of the
 *  arithmetic, not just the stylesheet: the thresholds below have to pay for it. */
export const NAME_PLUS_STATUS_GAP_PX = 8;

/** Name + gap + status text = 188 px. Under this the status cannot be a sentence without
 *  eating the filename, which it is never allowed to do. */
export const NAME_AND_TEXT_MIN_PX =
  NAME_MIN_PX + NAME_PLUS_STATUS_GAP_PX + STATUS_TEXT_MIN_PX;

/** Name + gap + status icon = 60 px. Under this a control keeps its icon and the name
 *  goes: a button nobody can press is worth less than a name nobody asked for. */
export const NAME_AND_ICON_MIN_PX =
  NAME_MIN_PX + NAME_PLUS_STATUS_GAP_PX + STATUS_ICON_MIN_PX;

/**
 * Given a clip's drawn width and what it has to say, what goes in the box.
 *
 * `MIN_CLIP_WIDTH_PX` (3 px, `hop.ts`) is untouched by any of this: a sliver stays a
 * coloured tick, which is a true and useful thing for a clip to be. It simply carries no
 * text, because 3 px of text is not text.
 */
export function clipChrome(widthPx: number, status: ClipStatusKind): ClipChrome {
  // A NaN width (a clip whose geometry has not settled) must not smuggle a `true` through
  // a `>=`: every comparison below is written so that a non-number falls to "nothing fits".
  const w = Number.isFinite(widthPx) ? widthPx : 0;

  if (status === "none") {
    return { name: w >= NAME_MIN_PX ? "ellipsis" : "none", status: "none" };
  }

  // Room for both, in full. The flex row shares out whatever is left over: the status is
  // fixed-size, the name takes the rest and ellipsises inside it.
  if (w >= NAME_AND_TEXT_MIN_PX) return { name: "ellipsis", status: "text" };

  if (status === "info") {
    // Nothing to press, so nothing to insist on. The string moves to the slot's `title`
    // (WaveformCanvas) and the pixels go back to the filename, which is the one thing the
    // operator is actually scanning a row of clips for.
    return { name: w >= NAME_MIN_PX ? "ellipsis" : "none", status: "none" };
  }

  // A control: keep it, in the smallest form that is still a target, and give the name
  // whatever is left.
  if (w >= NAME_AND_ICON_MIN_PX) return { name: "ellipsis", status: "icon" };
  if (w >= STATUS_ICON_MIN_PX) return { name: "none", status: "icon" };
  return { name: "none", status: "none" };
}
