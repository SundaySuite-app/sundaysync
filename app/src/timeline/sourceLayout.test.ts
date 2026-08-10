import { describe, it, expect } from "vitest";
import { sourceSpans } from "./sourceLayout";
import type { Device, FileEntry, ScanManifest } from "../types";

// The pre-sync layout (v0.4, D-061). What is worth testing here is exactly what the
// timeline would otherwise lie about: which clock positions a clip, what happens when a
// file has no clock at all, and whether a device override moves a clip on the timeline the
// same way it moves a row in the panel.

function device(id: string, kind: Device["kind"] = "video"): Device {
  return { id, label: id, kind, files: [] };
}

function file(over: Partial<FileEntry> & { file: string; device: string }): FileEntry {
  return {
    duration_seconds: 60,
    format_name: "mov,mp4",
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
    video: null,
    creation_time: null,
    ...over,
  };
}

function manifest(devices: Device[], files: FileEntry[]): ScanManifest {
  return { schema: 1, devices, files, unsynced: [] };
}

describe("sourceSpans", () => {
  it("positions clips by creation time, with the earliest file at zero", () => {
    const { tracks, unknownStart } = sourceSpans(
      manifest(
        [device("cam-a"), device("cam-b")],
        [
          file({
            file: "/a/C1.MP4",
            device: "cam-a",
            creation_time: "2026-08-09T10:00:00.000Z",
            duration_seconds: 90,
          }),
          file({
            file: "/b/C1.MP4",
            device: "cam-b",
            creation_time: "2026-08-09T10:00:30.000Z",
            duration_seconds: 30,
          }),
        ],
      ),
      {},
    );

    expect(unknownStart.size).toBe(0);
    expect(tracks.map((t) => t.device.id)).toEqual(["cam-a", "cam-b"]);
    expect(tracks[0].spans).toEqual([{ file: "/a/C1.MP4", startMs: 0, endMs: 90_000 }]);
    // 30 s later than the origin, 30 s long.
    expect(tracks[1].spans).toEqual([{ file: "/b/C1.MP4", startMs: 30_000, endMs: 60_000 }]);
  });

  it("takes the origin from the earliest stamp, whatever order the files arrive in", () => {
    const { tracks } = sourceSpans(
      manifest(
        [device("cam-a")],
        [
          file({ file: "/a/late.MP4", device: "cam-a", creation_time: "2026-08-09T10:01:00Z" }),
          file({ file: "/a/early.MP4", device: "cam-a", creation_time: "2026-08-09T10:00:00Z" }),
        ],
      ),
      {},
    );

    const byFile = new Map(tracks[0].spans.map((s) => [s.file, s]));
    expect(byFile.get("/a/early.MP4")!.startMs).toBe(0);
    expect(byFile.get("/a/late.MP4")!.startMs).toBe(60_000);
  });

  it("puts a file with no creation time at zero and reports it as unknown", () => {
    const { tracks, unknownStart } = sourceSpans(
      manifest(
        [device("cam-a"), device("rec", "audio")],
        [
          file({
            file: "/a/C1.MP4",
            device: "cam-a",
            creation_time: "2026-08-09T10:05:00Z",
            duration_seconds: 120,
          }),
          // A WAV/BWF from a field recorder: no container timestamp at all.
          file({ file: "/r/ZOOM0001.WAV", device: "rec", duration_seconds: 3600 }),
        ],
      ),
      {},
    );

    expect(unknownStart.has("/r/ZOOM0001.WAV")).toBe(true);
    expect(unknownStart.size).toBe(1);
    const rec = tracks.find((t) => t.device.id === "rec")!;
    expect(rec.spans).toEqual([{ file: "/r/ZOOM0001.WAV", startMs: 0, endMs: 3_600_000 }]);
    // …and the timestamped file keeps its own zero: a file with no clock must not drag
    // the origin (it would otherwise be "before the epoch" and push everything off-screen).
    const cam = tracks.find((t) => t.device.id === "cam-a")!;
    expect(cam.spans[0].startMs).toBe(0);
  });

  it("treats an unparseable creation time exactly like a missing one", () => {
    const { tracks, unknownStart } = sourceSpans(
      manifest([device("cam-a")], [file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "not a date" })]),
      {},
    );
    expect(unknownStart.has("/a/C1.MP4")).toBe(true);
    expect(tracks[0].spans[0].startMs).toBe(0);
  });

  it("regroups under the override overlay, dropping a device it empties", () => {
    const scan = manifest(
      [device("cam-a"), device("rec", "audio")],
      [
        file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "2026-08-09T10:00:00Z" }),
        file({ file: "/r/ZOOM0001.WAV", device: "rec", duration_seconds: 3600 }),
      ],
    );

    const moved = sourceSpans(scan, { "/a/C1.MP4": "rec" });

    // Same rule as the panel's `grouped` memo: a device the overlay empties disappears.
    expect(moved.tracks.map((t) => t.device.id)).toEqual(["rec"]);
    expect(moved.tracks[0].spans.map((s) => s.file).sort()).toEqual([
      "/a/C1.MP4",
      "/r/ZOOM0001.WAV",
    ]);
  });

  it("skips a file whose effective device is not in the manifest", () => {
    const { tracks } = sourceSpans(
      manifest([device("cam-a")], [file({ file: "/a/C1.MP4", device: "cam-a" })]),
      { "/a/C1.MP4": "ghost" },
    );
    expect(tracks).toEqual([]);
  });

  it("answers an empty manifest with no tracks and nothing unknown", () => {
    const { tracks, unknownStart } = sourceSpans(manifest([], []), {});
    expect(tracks).toEqual([]);
    expect(unknownStart.size).toBe(0);
  });
});

// ── A stamp that parses but cannot be true (V04-U5) ────────────────────────────────────
//
// Found in the v0.4 QA sweep. `Date.parse` was the only gate, so one camera whose battery
// had gone flat — reporting 1970-01-01 with complete confidence — set the drop's origin
// fifty-six years early. `contentBounds` then returned a span of ~1.8 × 10¹² ms,
// `fitPxPerMs` clamped to `MIN_PX_PER_MS`, and the whole shoot went off the right edge of a
// timeline that looked, to the operator, like an app that had failed to read the card.

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sourceSpans and clocks that cannot be true", () => {
  it("treats a dead camera clock as no clock at all, not as the drop's origin", () => {
    const scan = manifest(
      [device("cam-a"), device("cam-b"), device("dud")],
      [
        file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "2026-08-09T10:00:00Z" }),
        file({ file: "/b/C2.MP4", device: "cam-b", creation_time: "2026-08-09T10:10:00Z" }),
        // Flat battery: the camera came back at the epoch and wrote it down.
        file({ file: "/d/C3.MP4", device: "dud", creation_time: "1970-01-01T00:00:00Z" }),
      ],
    );

    const { tracks, unknownStart } = sourceSpans(scan, {});

    expect([...unknownStart]).toEqual(["/d/C3.MP4"]);
    const startOf = (file: string) =>
      tracks.flatMap((t) => t.spans).find((s) => s.file === file)!.startMs;
    // The two real cards keep their true ten-minute separation, and the earliest of THEM
    // is zero — the dud does not get to define the origin.
    expect(startOf("/a/C1.MP4")).toBe(0);
    expect(startOf("/b/C2.MP4")).toBe(10 * 60 * 1000);
    expect(startOf("/d/C3.MP4")).toBe(0);
  });

  it("keeps a whole session together, however long the session is", () => {
    // Six hours is a long day, not an impossible one: still one drop, still one origin.
    const scan = manifest(
      [device("cam-a"), device("cam-b")],
      [
        file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "2026-08-09T08:00:00Z" }),
        file({ file: "/b/C2.MP4", device: "cam-b", creation_time: "2026-08-09T14:00:00Z" }),
      ],
    );
    const { unknownStart, tracks } = sourceSpans(scan, {});
    expect(unknownStart.size).toBe(0);
    expect(tracks.flatMap((t) => t.spans).find((s) => s.file === "/b/C2.MP4")!.startMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("keeps the LATER of two equally-sized clusters — a broken clock reads early", () => {
    const scan = manifest(
      [device("cam-a"), device("cam-b")],
      [
        file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "2020-01-01T00:00:00Z" }),
        file({ file: "/b/C2.MP4", device: "cam-b", creation_time: "2026-08-09T10:00:00Z" }),
      ],
    );
    // Neither file has company, so size cannot decide. A camera that lost its clock falls
    // back to a fixed date in the past; nothing makes one jump forward.
    expect([...sourceSpans(scan, {}).unknownStart]).toEqual(["/a/C1.MP4"]);
  });

  it("believes the majority when one card is the odd one out", () => {
    const base = Date.parse("2026-08-09T10:00:00Z");
    const scan = manifest(
      [device("cam-a"), device("cam-b"), device("cam-c"), device("dud")],
      [
        file({ file: "/a.MP4", device: "cam-a", creation_time: new Date(base).toISOString() }),
        file({
          file: "/b.MP4",
          device: "cam-b",
          creation_time: new Date(base + 60_000).toISOString(),
        }),
        file({
          file: "/c.MP4",
          device: "cam-c",
          creation_time: new Date(base + 120_000).toISOString(),
        }),
        // Three days ahead — a clock set to the wrong date, and outnumbered.
        file({
          file: "/dud.MP4",
          device: "dud",
          creation_time: new Date(base + 3 * DAY_MS).toISOString(),
        }),
      ],
    );
    expect([...sourceSpans(scan, {}).unknownStart]).toEqual(["/dud.MP4"]);
  });

  it("leaves a single stamped file alone — one clock cannot contradict itself", () => {
    const scan = manifest(
      [device("cam-a")],
      [file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "1970-01-01T00:00:00Z" })],
    );
    // Absurd on its face, but there is nothing to compare it with, and it positions
    // nothing: it is the origin, it sits at zero, and the sync is about to answer anyway.
    expect(sourceSpans(scan, {}).unknownStart.size).toBe(0);
  });
});
