import { describe, expect, it } from "vitest";
import { CACHE_MISSING } from "../errors";
import { en, nb } from "../i18n";
import { classifyWaveformError } from "./waveformStore";

/** The D-046 activity-guard refusals, verbatim as `ActivityGuard::begin` emits them. */
const BUSY_SYNC = "busy: sync in progress";
const BUSY_MAINTENANCE = "busy: cache maintenance in progress";

describe("classifyWaveformError", () => {
  it("classifies the D-046 busy refusal as busy, not as an unknown crash", () => {
    for (const raw of [BUSY_SYNC, BUSY_MAINTENANCE]) {
      for (const t of [nb, en]) {
        expect(classifyWaveformError(raw, t).kind).toBe("busy");
        expect(classifyWaveformError(new Error(raw), t).kind).toBe("busy");
      }
    }
  });

  it("says which activity is holding the slot, in the operator's language", () => {
    // Finding 6: this used to go through `mapEngineError`, which had no busy branch, so
    // it fell through to `errUnknown` and the Norwegian UI read «Noe gikk galt: busy:
    // sync in progress» — English engine text, crash-shaped wording for a self-clearing
    // condition, in a slot that is ~28 px tall and cannot wrap. The fix then was to route
    // AROUND the mapping and keep the raw string as the detail; that stopped the crash
    // wording but left English in the tooltip.
    //
    // R/D-094 gives `busy:` its own branch instead — one sentence per activity — so this
    // goes back THROUGH the mapping and comes out translated. Still not `errUnknown`, and
    // still not the raw text.
    const nbBusy = classifyWaveformError(BUSY_SYNC, nb);
    expect(nbBusy.text).toBe(nb.errBusySync);
    expect(nbBusy.text).not.toBe(nb.errUnknown(BUSY_SYNC));
    expect(nbBusy.text).not.toContain("Noe gikk galt");
    expect(nbBusy.text).not.toContain(BUSY_SYNC);
    expect(classifyWaveformError(BUSY_MAINTENANCE, nb).text).toBe(nb.errBusyMaintenance);
    expect(classifyWaveformError(BUSY_SYNC, en).text).toBe(en.errBusySync);
  });

  it("still classifies a cache miss as regenerable, with the source path", () => {
    const file = "/Users/e2e/shoot/CamA/C0001.MP4";
    const e = classifyWaveformError(`${CACHE_MISSING}${file}`, nb);
    expect(e.kind).toBe("cacheMissing");
    expect(e.path).toBe(file);
    expect(e.text).toBe(nb.errCacheMissing);
  });

  it("everything else is `other`, with the generic mapping kept as the detail", () => {
    const e = classifyWaveformError("io: Resource temporarily unavailable", nb);
    expect(e.kind).toBe("other");
    expect(e.text).toBe(nb.errUnknown("io: Resource temporarily unavailable"));
  });
});
