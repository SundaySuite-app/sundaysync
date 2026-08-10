import { describe, expect, it } from "vitest";
import {
  clipChrome,
  NAME_AND_ICON_MIN_PX,
  NAME_AND_TEXT_MIN_PX,
  NAME_MIN_PX,
  NAME_PLUS_STATUS_GAP_PX,
  MIN_WAVEFORM_PX,
  STATUS_ICON_MIN_PX,
  STATUS_TEXT_MIN_PX,
  waveformFits,
} from "../timeline/clipChrome";

// V05-W1, D-065. Every threshold from BOTH sides: a width rule whose boundaries are only
// tested from the roomy side is a rule that has never been asked the question it exists
// for. The one that mattered — a 386-file wedding's clips a few pixels wide — is the
// narrow side of every one of these.

describe("the composite thresholds are what the parts add up to", () => {
  it("names its arithmetic rather than hiding two magic numbers", () => {
    expect(NAME_AND_TEXT_MIN_PX).toBe(NAME_MIN_PX + NAME_PLUS_STATUS_GAP_PX + STATUS_TEXT_MIN_PX);
    expect(NAME_AND_ICON_MIN_PX).toBe(NAME_MIN_PX + NAME_PLUS_STATUS_GAP_PX + STATUS_ICON_MIN_PX);
    expect(NAME_AND_TEXT_MIN_PX).toBe(188);
    expect(NAME_AND_ICON_MIN_PX).toBe(60);
  });
});

describe("a clip with nothing to say", () => {
  it("shows its name from NAME_MIN_PX up, and nothing below it", () => {
    expect(clipChrome(NAME_MIN_PX - 1, "none")).toEqual({ name: "none", status: "none" });
    expect(clipChrome(NAME_MIN_PX, "none")).toEqual({ name: "ellipsis", status: "none" });
  });

  it("a 3 px sliver is a coloured tick, not a smear of text", () => {
    // `MIN_CLIP_WIDTH_PX` (hop.ts) is deliberately untouched by any of this: the box stays,
    // it just carries nothing.
    expect(clipChrome(3, "none")).toEqual({ name: "none", status: "none" });
  });

  it("still shows the name at any width above the floor", () => {
    expect(clipChrome(1200, "none")).toEqual({ name: "ellipsis", status: "none" });
  });
});

describe("a control — the operator has to be able to act", () => {
  it("is nothing at all below the icon floor", () => {
    expect(clipChrome(STATUS_ICON_MIN_PX - 1, "control")).toEqual({
      name: "none",
      status: "none",
    });
  });

  it("becomes an icon at exactly the icon floor, and keeps it over the name", () => {
    // Between 22 and 60 the name would technically fit on its own (NAME_MIN_PX is 30) —
    // but a button nobody can press is worth less than a name nobody asked for.
    expect(clipChrome(STATUS_ICON_MIN_PX, "control")).toEqual({ name: "none", status: "icon" });
    expect(clipChrome(NAME_MIN_PX, "control")).toEqual({ name: "none", status: "icon" });
    expect(clipChrome(NAME_AND_ICON_MIN_PX - 1, "control")).toEqual({
      name: "none",
      status: "icon",
    });
  });

  it("gains the name back once icon + gap + name fits", () => {
    expect(clipChrome(NAME_AND_ICON_MIN_PX, "control")).toEqual({
      name: "ellipsis",
      status: "icon",
    });
  });

  it("stays an icon right up to the text threshold, then becomes the sentence", () => {
    expect(clipChrome(NAME_AND_TEXT_MIN_PX - 1, "control")).toEqual({
      name: "ellipsis",
      status: "icon",
    });
    expect(clipChrome(NAME_AND_TEXT_MIN_PX, "control")).toEqual({
      name: "ellipsis",
      status: "text",
    });
    expect(clipChrome(1200, "control")).toEqual({ name: "ellipsis", status: "text" });
  });
});

describe("an informational line — never at the filename's expense", () => {
  it("does not exist below the text threshold, and the name is untouched by it", () => {
    // The whole difference from a control. «Analyserer …» is worth nothing to press and
    // must never be the reason a row of clips is anonymous; it moves to the tooltip.
    expect(clipChrome(NAME_AND_TEXT_MIN_PX - 1, "info")).toEqual({
      name: "ellipsis",
      status: "none",
    });
    expect(clipChrome(NAME_MIN_PX, "info")).toEqual({ name: "ellipsis", status: "none" });
    expect(clipChrome(NAME_MIN_PX - 1, "info")).toEqual({ name: "none", status: "none" });
  });

  it("never takes the icon form — there is nothing to press", () => {
    for (const w of [STATUS_ICON_MIN_PX, NAME_AND_ICON_MIN_PX, NAME_AND_TEXT_MIN_PX - 1]) {
      expect(clipChrome(w, "info").status).not.toBe("icon");
    }
  });

  it("is a sentence from the text threshold up, beside the name", () => {
    expect(clipChrome(NAME_AND_TEXT_MIN_PX, "info")).toEqual({
      name: "ellipsis",
      status: "text",
    });
  });
});

describe("widths that are not measurements", () => {
  it("treats a NaN or infinite width as no room, never as room", () => {
    // A clip whose geometry has not settled must not smuggle a `true` through a `>=`.
    for (const kind of ["none", "control", "info"] as const) {
      expect(clipChrome(Number.NaN, kind)).toEqual({ name: "none", status: "none" });
    }
    expect(clipChrome(Number.POSITIVE_INFINITY, "control")).toEqual({
      name: "none",
      status: "none",
    });
  });

  it("treats a negative width as no room", () => {
    expect(clipChrome(-40, "control")).toEqual({ name: "none", status: "none" });
  });
});

// V05-W5, D-072. The waveform's own floor, and the composition with the name's.

describe("waveformFits", () => {
  it("is exact at the threshold, from both sides", () => {
    expect(waveformFits(MIN_WAVEFORM_PX - 0.01)).toBe(false);
    expect(waveformFits(MIN_WAVEFORM_PX)).toBe(true);
    expect(waveformFits(MIN_WAVEFORM_PX + 1)).toBe(true);
  });

  it("refuses the widths a 386-file drop actually draws at its fitted zoom", () => {
    // Measured: 302 placements across three hours in a ~1150 px viewport put every clip
    // between 3 and 10 px. Not one of them is a waveform.
    for (const w of [3, 5, 9.2, 10, 23]) expect(waveformFits(w)).toBe(false);
  });

  it("treats a width that is not a measurement as no room, like clipChrome does", () => {
    expect(waveformFits(Number.NaN)).toBe(false);
    expect(waveformFits(Number.POSITIVE_INFINITY)).toBe(false);
    expect(waveformFits(-40)).toBe(false);
  });

  it("sits under the name's floor: a box too small for a name is too small for a waveform", () => {
    // The composition D-072 claims, asserted rather than described. Anything wide enough
    // for a filename is wide enough for a waveform, and there is a band in between where a
    // clip draws bars and no name — which is deliberate, not an accident of two constants.
    expect(MIN_WAVEFORM_PX).toBeLessThan(NAME_MIN_PX);
    for (let w = 0; w <= 60; w += 0.5) {
      if (clipChrome(w, "none").name !== "none") expect(waveformFits(w)).toBe(true);
    }
  });

  it("a clip that can still show its rebuild control may have no waveform behind it", () => {
    // 22 px (STATUS_ICON_MIN_PX) < 24 px: the control is the last thing to go (D-065) and
    // the waveform is not, so the two floors do NOT coincide. Stated here so a later reader
    // does not "tidy" them into one number.
    expect(STATUS_ICON_MIN_PX).toBeLessThan(MIN_WAVEFORM_PX);
    expect(clipChrome(STATUS_ICON_MIN_PX, "control").status).toBe("icon");
    expect(waveformFits(STATUS_ICON_MIN_PX)).toBe(false);
  });
});
