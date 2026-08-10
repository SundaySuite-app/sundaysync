import { describe, expect, it } from "vitest";
import { en, nb } from "../i18n";

// D-042 (E6) shipped `<timeMap>` drift correction, on by default, the same day this copy
// was still telling the user it was "coming in a later version" — the exact class of
// stale-copy-vs-shipped-behaviour drift this suite exists to catch (§ seam audit: i18n
// VALUE drift, not just nb/en key parity).
describe("drift warning copy (D-042)", () => {
  it("no longer claims automatic drift correction is a future feature", () => {
    const nbText = nb.drift(42);
    const enText = en.drift(42);
    expect(nbText).not.toContain("kommer i en senere versjon");
    expect(enText).not.toContain("coming in a later version");
  });

  it("both dictionaries describe the drift as corrected, not merely observed", () => {
    // Loose, language-agnostic proxies: the nb word "korriger*"/"retter" and the en word
    // "correct*" — precise enough to fail if the copy reverts to a bare observation with
    // no mention of correction at all, without hardcoding the whole sentence.
    expect(nb.drift(42).toLowerCase()).toMatch(/korriger|retter/);
    expect(en.drift(42).toLowerCase()).toMatch(/correct/);
  });
});

// D-066 (V05-W2): the skipped line is the honesty counter for files the scan walked past.
// It is one sentence assembled from two independent counts, either of which can be zero,
// so the grammar has four shapes per language and none of them may read as machine output.
describe("skipped-files summary (D-066)", () => {
  it("counts both classes, in both languages", () => {
    // The owner's wedding, as measured: eight DJI `.LRF` proxies plus three other sidecars,
    // and one `IMG_4164.HEIC`.
    expect(nb.skippedSummary(11, 1)).toBe("11 følgefiler og 1 stillbilde ble hoppet over");
    expect(en.skippedSummary(11, 1)).toBe("11 sidecar files and 1 still image were skipped");
  });

  it("says nothing about a class that has no members", () => {
    expect(nb.skippedSummary(8, 0)).toBe("8 følgefiler ble hoppet over");
    expect(en.skippedSummary(8, 0)).toBe("8 sidecar files were skipped");
    expect(nb.skippedSummary(0, 3)).toBe("3 stillbilder ble hoppet over");
    expect(en.skippedSummary(0, 3)).toBe("3 still images were skipped");
  });

  it("gets the singular right, including the English verb", () => {
    expect(nb.skippedSummary(1, 0)).toBe("1 følgefil ble hoppet over");
    expect(en.skippedSummary(1, 0)).toBe("1 sidecar file was skipped");
    expect(nb.skippedSummary(0, 1)).toBe("1 stillbilde ble hoppet over");
    expect(en.skippedSummary(0, 1)).toBe("1 still image was skipped");
    // One of each is still a plural subject: "were", not "was".
    expect(en.skippedSummary(1, 1)).toBe("1 sidecar file and 1 still image were skipped");
  });

  it("labels each reason in the operator's own words, never the wire spelling", () => {
    for (const t of [nb, en]) {
      expect(t.skippedReason("sidecar")).not.toContain("_");
      expect(t.skippedReason("still_image")).not.toContain("_");
      expect(t.skippedReason("sidecar")).not.toBe(t.skippedReason("still_image"));
    }
    expect(nb.skippedReason("still_image")).toBe("stillbilde");
    expect(en.skippedReason("still_image")).toBe("still image");
  });
});
