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
