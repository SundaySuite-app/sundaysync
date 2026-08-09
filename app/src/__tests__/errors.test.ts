import { describe, expect, it } from "vitest";
import { mapEngineError } from "../errors";
import { nb } from "../i18n";

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
});
