import { describe, expect, it } from "vitest";
import { releaseNotes, type UpdateStatus } from "../update";

// D-095. `releaseNotes` is the one place a value that arrived over the network becomes a
// thing the settings dialog branches on ("is there a box, or is there nothing"), and the
// field is OPTIONAL on both sides of the IPC: an install running this build can be talking
// to a feed whose newest release predates the note mechanism entirely.

describe("releaseNotes (D-095)", () => {
  it("returns the note an offer carries", () => {
    expect(releaseNotes({ phase: "available", version: "0.6.0-beta.6", notes: "Nytt: en ting." }))
      .toBe("Nytt: en ting.");
    expect(
      releaseNotes({ phase: "readyToInstall", version: "0.6.0-beta.6", notes: "Nytt: en ting." }),
    ).toBe("Nytt: en ting.");
    // Assembled in the renderer from `update:progress`, so it can carry the note forward.
    expect(
      releaseNotes({
        phase: "downloading",
        version: "0.6.0-beta.6",
        percent: 42,
        notes: "Nytt: en ting.",
      }),
    ).toBe("Nytt: en ting.");
  });

  it("keeps the note's own line breaks — they are its paragraphs", () => {
    expect(
      releaseNotes({ phase: "available", version: "1.0.0", notes: "Første linje.\n\nAndre." }),
    ).toBe("Første linje.\n\nAndre.");
  });

  it("treats absent, null and whitespace-only as nothing to show", () => {
    // A release from before the note mechanism: the backend omits the field entirely.
    expect(releaseNotes({ phase: "available", version: "0.6.0-beta.5" })).toBeNull();
    expect(releaseNotes({ phase: "available", version: "1.0.0", notes: null })).toBeNull();
    expect(releaseNotes({ phase: "available", version: "1.0.0", notes: "" })).toBeNull();
    expect(releaseNotes({ phase: "available", version: "1.0.0", notes: "  \n\t " })).toBeNull();
  });

  it("trims, so a leading blank line never opens the box with an empty row", () => {
    expect(releaseNotes({ phase: "available", version: "1.0.0", notes: "\n Nytt. \n\n" })).toBe(
      "Nytt.",
    );
  });

  it("is null for every phase that is not an offer", () => {
    const notOffers: UpdateStatus[] = [
      { phase: "idle" },
      { phase: "checking" },
      { phase: "upToDate" },
      { phase: "error", message: "network unreachable" },
    ];
    for (const status of notOffers) expect(releaseNotes(status)).toBeNull();
  });

  it("survives a feed that sends something other than a string", () => {
    // Not reachable through the Rust command, which types the field — but the value comes
    // off the network and the renderer must not throw on a shape it did not expect.
    const bogus = { phase: "available", version: "1.0.0", notes: 42 } as unknown as UpdateStatus;
    expect(releaseNotes(bogus)).toBeNull();
  });
});
