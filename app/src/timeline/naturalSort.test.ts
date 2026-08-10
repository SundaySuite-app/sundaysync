import { describe, it, expect } from "vitest";
import { compareNatural, sortNatural } from "./naturalSort";

// D-068 lays untimed files out in this order and nothing else, so this comparison IS the
// claim the timeline makes about them. Every case below is a real filename family from the
// owner's 386-file wedding drop, not an invented one.

describe("compareNatural over the drop's four real filename families", () => {
  it("orders a Fujifilm card by its number, not by its digits as text", () => {
    // The case `localeCompare` gets wrong: "10000" < "6408" as text, because `1` < `6`.
    expect(
      sortNatural(["/f/DSCF10000.MOV", "/f/DSCF640.MOV", "/f/DSCF6408.MOV"]),
    ).toEqual(["/f/DSCF640.MOV", "/f/DSCF6408.MOV", "/f/DSCF10000.MOV"]);
  });

  it("orders an AVCHD card whose names are nothing but zero-padded numbers", () => {
    expect(sortNatural(["/j/02118.MTS", "/j/02106.MTS", "/j/02242.MTS"])).toEqual([
      "/j/02106.MTS",
      "/j/02118.MTS",
      "/j/02242.MTS",
    ]);
  });

  it("orders a mixer's `uirec-YYYYMMDD_HHMMSS` names chronologically, because they sort so", () => {
    expect(
      sortNatural([
        "/m/uirec-20260725_155446.wav",
        "/m/uirec-20260724_141546.wav",
        "/m/uirec-20260725_125533.wav",
      ]),
    ).toEqual([
      "/m/uirec-20260724_141546.wav",
      "/m/uirec-20260725_125533.wav",
      "/m/uirec-20260725_155446.wav",
    ]);
  });

  it("puts a Zoom F6's takes in take order, which lives in the FOLDER name", () => {
    // The reason directory segments are compared as segments: every take's files are named
    // alike, and only the folder tells them apart.
    expect(
      sortNatural([
        "/z/260725_007.TAKE/260725_007_Tr1.WAV",
        "/z/260725_001.TAKE/260725_001_TrL_R.WAV",
        "/z/260725_001.TAKE/260725_001_Tr1.WAV",
        "/z/260725_005_0002.TAKE/260725_005_0002_Tr1.WAV",
        "/z/260725_005_0001.TAKE/260725_005_0001_Tr1.WAV",
      ]),
    ).toEqual([
      "/z/260725_001.TAKE/260725_001_Tr1.WAV",
      "/z/260725_001.TAKE/260725_001_TrL_R.WAV",
      "/z/260725_005_0001.TAKE/260725_005_0001_Tr1.WAV",
      "/z/260725_005_0002.TAKE/260725_005_0002_Tr1.WAV",
      "/z/260725_007.TAKE/260725_007_Tr1.WAV",
    ]);
  });
});

describe("compareNatural is a total order", () => {
  it("compares directory segments before the basename", () => {
    // Whole-string comparison would put `b/…` after `az/…` here (because `z` > `/`), which
    // is not the order any file browser shows.
    expect(compareNatural("/x/b/1.wav", "/x/az/9.wav")).toBeGreaterThan(0);
  });

  it("sorts a shallower path before a deeper one that shares every segment", () => {
    expect(compareNatural("/x/A/B", "/x/A/B/c.wav")).toBeLessThan(0);
  });

  it("reads both path separators, because a Windows manifest carries backslashes", () => {
    expect(compareNatural("C:\\shoot\\A\\2.mov", "C:/shoot/A/10.mov")).toBeLessThan(0);
  });

  it("puts digits before letters at the same position", () => {
    expect(compareNatural("/x/2.mov", "/x/A.mov")).toBeLessThan(0);
  });

  it("treats case as a mood, not as a sequence — but still orders the two", () => {
    expect(compareNatural("/x/IMG_2.mov", "/x/img_10.mov")).toBeLessThan(0);
    expect(compareNatural("/x/a.mov", "/x/A.mov")).not.toBe(0);
  });

  it("does not collapse a run of digits longer than a float can hold", () => {
    // `Number("...")` would make these equal, and a comparator returning 0 for two
    // different files hands their layout order to the sort's stability instead of to a
    // decision anyone made.
    const a = "/x/9007199254740993.wav";
    const b = "/x/9007199254740992.wav";
    expect(compareNatural(a, b)).toBeGreaterThan(0);
  });

  it("gives two spellings of the same number a stable order", () => {
    expect(compareNatural("/x/01.wav", "/x/1.wav")).toBeGreaterThan(0);
  });

  it("is antisymmetric and reflexive over the whole drop", () => {
    const files = [
      "/f/DSCF6408.MOV",
      "/j/02106.MTS",
      "/z/260725_001.TAKE/260725_001_Tr1.WAV",
      "/m/uirec-20260725_125533.wav",
      "/x/A.mov",
      "/x/2.mov",
    ];
    for (const a of files) {
      expect(compareNatural(a, a)).toBe(0);
      for (const b of files) {
        // Written as a sum rather than as `sign(x) === -sign(y)`, because `Math.sign(0)`
        // is `+0` and its negation is `-0`, and the two are not `Object.is`-equal.
        expect(Math.sign(compareNatural(a, b)) + Math.sign(compareNatural(b, a))).toBe(0);
      }
    }
  });

  it("never sorts the caller's array in place — it is the manifest's", () => {
    const input = ["/x/b.wav", "/x/a.wav"];
    const sorted = sortNatural(input);
    expect(input).toEqual(["/x/b.wav", "/x/a.wav"]);
    expect(sorted).toEqual(["/x/a.wav", "/x/b.wav"]);
  });
});
