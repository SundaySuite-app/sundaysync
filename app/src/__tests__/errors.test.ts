import { describe, expect, it } from "vitest";
import { mapEngineError } from "../errors";
import { en, nb } from "../i18n";

describe("mapEngineError (D-030)", () => {
  it("maps cancelled to a NOTICE, never an error", () => {
    const m = mapEngineError("cancelled", nb);
    expect(m.kind).toBe("notice");
    expect(m.text).toBe(nb.noticeCancelled);
  });

  it("maps no-input", () => {
    expect(mapEngineError("no input files were given", nb)).toEqual({
      kind: "error",
      text: nb.errNoInput,
    });
  });

  it("maps sidecar-unavailable regardless of the detail suffix", () => {
    const m = mapEngineError("ffmpeg sidecar unavailable: `ffprobe` could not be run", nb);
    expect(m.kind).toBe("error");
    expect(m.text).toBe(nb.errSidecar);
  });

  it("extracts the path from an io error", () => {
    const m = mapEngineError("failed to read /media/C0001.MP4: permission denied", nb);
    expect(m.kind).toBe("error");
    expect(m.text).toContain("/media/C0001.MP4");
    expect(m.text).not.toContain("permission denied");
  });

  it("keeps the detail on an invariant violation — it is a bug report", () => {
    const m = mapEngineError("internal invariant violated: a file was lost", nb);
    expect(m.kind).toBe("error");
    expect(m.text).toContain("a file was lost");
  });

  it("passes unknown errors through with the raw text embedded (§7.5 honesty)", () => {
    const m = mapEngineError("mystery explosion", nb);
    expect(m.kind).toBe("error");
    expect(m.text).toContain("mystery explosion");
  });

  it("classifies a missing analysis-cache entry as its own state, not an error (D-052)", () => {
    // V03-S2: the waveform is not built yet. The UI's answer is a regenerate button, so
    // this must never collapse into the generic `errUnknown` red banner — and it must
    // carry the clip path back out, because that is the argument `regenerate_analysis`
    // takes.
    const m = mapEngineError("cache_missing:/Users/kari/Opptak/Cam A/C0001.MP4", nb);
    expect(m.kind).toBe("cacheMissing");
    expect(m).toHaveProperty("path", "/Users/kari/Opptak/Cam A/C0001.MP4");
    // Every variant carries `text`, so existing consumers keep rendering something.
    expect(m.text.length).toBeGreaterThan(0);
  });

  it("survives the prefix arriving wrapped in an Error (D-052)", () => {
    // `String(e)` on a rejected invoke yields "Error: cache_missing:…" — the same shape
    // the invoke-timeout case already has to tolerate.
    const m = mapEngineError("Error: cache_missing:/media/C0002.MP4", nb);
    expect(m.kind).toBe("cacheMissing");
    expect(m).toHaveProperty("path", "/media/C0002.MP4");
  });
  // ── The messages the tidy-up round gave sentences of their own (R, D-094) ────────────
  //
  // Every one below is a string the shell or the engine really produces, chosen because an
  // operator can produce it by USING the app. Before this each fell through to `errUnknown`
  // and put raw English on a Norwegian banner — «Noe gikk galt: busy: sync in progress»
  // being the one the design review actually caught in the wild.

  it("names WHICH activity is holding the D-046 slot, as a notice rather than an error", () => {
    // A wait is not a failure: `kind` decides the banner colour, and a red banner for
    // «the sync you started is still running» is the app telling the operator it broke.
    for (const [raw, text] of [
      ["busy: sync in progress", nb.errBusySync],
      ["busy: cache maintenance in progress", nb.errBusyMaintenance],
      ["busy: analysis in progress", nb.errBusyPrewarm],
      ["busy: the app is busy", nb.errBusy],
    ] as const) {
      const m = mapEngineError(raw, nb);
      expect(m.kind).toBe("notice");
      expect(m.text).toBe(text);
      // The whole point: no English survives into the sentence.
      expect(m.text).not.toContain("busy:");
    }
  });

  it("reads a mis-drop refusal for its limit, and drops the engine's own wording (D-032)", () => {
    const m = mapEngineError(
      "too many files to scan (limit 20000); this looks like a mis-selected folder",
      nb,
    );
    expect(m.kind).toBe("error");
    expect(m.text).toBe(nb.errTooManyFiles("20000"));
    expect(m.text).not.toContain("mis-selected");
  });

  it("keeps the path in a refused cache clear — it is the part the user has to change", () => {
    const m = mapEngineError(
      "refusing to clear /Volumes/Media/Opptak: not a SundaySync cache directory",
      nb,
    );
    expect(m.kind).toBe("error");
    expect(m.text).toContain("/Volumes/Media/Opptak");
    expect(m.text).not.toContain("not a SundaySync cache directory");
  });

  it("names the file an unreadable clip refusal is about, and nothing else", () => {
    const decode = mapEngineError("could not decode /media/C0003.MP4: no audio stream", nb);
    expect(decode.text).toBe(nb.errDecode("/media/C0003.MP4"));
    expect(decode.text).not.toContain("no audio stream");
    expect(mapEngineError("nothing was extracted for /media/C0004.MP4", nb).text).toBe(
      nb.errNoAudio("/media/C0004.MP4"),
    );
  });

  it("maps the remaining shell refusals an operator can reach", () => {
    expect(mapEngineError("nothing has been synced yet", nb).text).toBe(nb.errNothingSynced);
    expect(mapEngineError("internal state was poisoned", nb).text).toBe(nb.errPoisoned);
  });

  it("treats the updater's own timeout as the retry it is, not a crash", () => {
    // `update.ts`'s `withTimeout` rejects with an `Error`, so `String(e)` prefixes "Error: ".
    const m = mapEngineError("Error: update_check did not answer within 15000 ms", nb);
    expect(m.kind).toBe("notice");
    expect(m.text).toBe(nb.noticeTimeout);
  });

  it("frames an unmapped message instead of handing over bare English, and says so", () => {
    // §7.5. The raw text is the only fact there is and stays; what may not happen is it
    // landing alone. `unmapped` is how the updater knows not to wrap it a second time.
    const raw = "no common audio: the recorder and the cameras share no overlapping sound";
    const m = mapEngineError(raw, nb);
    expect(m.kind).toBe("error");
    expect(m).toHaveProperty("unmapped", true);
    expect(m.text).toContain(raw);
    expect(m.text).not.toBe(raw);
    expect(m.text.startsWith(raw)).toBe(false);
    // …and only the fallback is marked, or the flag would mean nothing.
    expect(mapEngineError("no input files were given", nb)).not.toHaveProperty("unmapped");
  });

  it("says all of it in English too — a half-translated dictionary is worse than none", () => {
    expect(mapEngineError("busy: sync in progress", en).text).toBe(en.errBusySync);
    expect(mapEngineError("nothing has been synced yet", en).text).toBe(en.errNothingSynced);
  });
});
