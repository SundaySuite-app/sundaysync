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
});
