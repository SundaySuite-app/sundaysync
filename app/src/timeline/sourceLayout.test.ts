import { describe, it, expect } from "vitest";
import { sourceSpans } from "./sourceLayout";
import { stackClips } from "./laneLayout";
import { contentBounds } from "./viewport";
import type { Device, FileEntry, ScanManifest } from "../types";

// The pre-sync layout (v0.4, D-061; rewritten V05-W3 for D-067/D-068/D-071). What is worth
// testing here is exactly what the timeline would otherwise lie about: which clock
// positions a clip, what happens to a file no clock could reach, and whether a device
// override moves a clip on the timeline the same way it moves a row in the panel.

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
    date_tag: null,
    modified_time: null,
    ...over,
  };
}

function manifest(devices: Device[], files: FileEntry[]): ScanManifest {
  return { schema: 1, devices, files, unsynced: [] };
}

/** Every drawn span, whichever track it landed on. */
function spansOf(layout: ReturnType<typeof sourceSpans>) {
  return new Map(layout.tracks.flatMap((t) => t.spans).map((s) => [s.file, s]));
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

  it("reports which rung of the ladder positioned each file", () => {
    // D-067 in one assertion: the layout carries the provenance, so the clip can say it.
    const layout = sourceSpans(
      manifest(
        [device("cam-a"), device("rec", "audio")],
        [
          file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "2026-08-09T10:00:00Z" }),
          file({ file: "/a/C2.MP4", device: "cam-a", creation_time: "2026-08-09T10:30:00Z" }),
          file({
            file: "/r/uirec-20260809_113000.wav",
            device: "rec",
            duration_seconds: 600,
          }),
        ],
      ),
      {},
    );
    expect(layout.timeSource.get("/a/C1.MP4")).toBe("container");
    expect(layout.timeSource.get("/r/uirec-20260809_113000.wav")).toBe("filename");
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
    const { tracks, unknownStart, outsideWindow } = sourceSpans(manifest([], []), {});
    expect(tracks).toEqual([]);
    expect(unknownStart.size).toBe(0);
    expect(outsideWindow.size).toBe(0);
  });
});

// ── D-068: files with no usable time are laid out in filename order ─────────────────────
//
// The owner's choice. The old behaviour put every untimed file at zero, which on a
// 14-take Zoom folder drew fourteen boxes on top of each other and called it a position.
// Order is a claim the app can actually make: the camera numbered the files.

describe("files nothing could time are laid out in order, not in a pile", () => {
  const untimedDrop = () =>
    manifest(
      [device("cam-a"), device("rec", "audio")],
      [
        file({
          file: "/a/C1.MP4",
          device: "cam-a",
          creation_time: "2026-08-09T10:00:00Z",
          duration_seconds: 120,
        }),
        file({
          file: "/a/C2.MP4",
          device: "cam-a",
          creation_time: "2026-08-09T10:05:00Z",
          duration_seconds: 60,
        }),
        // Three takes with nothing in them at all: no tags, no timestamp in the name.
        file({ file: "/r/T3.WAV", device: "rec", duration_seconds: 30 }),
        file({ file: "/r/T1.WAV", device: "rec", duration_seconds: 10 }),
        file({ file: "/r/T2.WAV", device: "rec", duration_seconds: 20 }),
      ],
    );

  it("lays them end to end with no gap, in filename order", () => {
    const layout = sourceSpans(untimedDrop(), {});
    const rec = layout.tracks.find((t) => t.device.id === "rec")!;
    expect(rec.spans).toEqual([
      { file: "/r/T1.WAV", startMs: 0, endMs: 10_000 },
      { file: "/r/T2.WAV", startMs: 10_000, endMs: 30_000 },
      { file: "/r/T3.WAV", startMs: 30_000, endMs: 60_000 },
    ]);
    expect([...layout.unknownStart].sort()).toEqual(["/r/T1.WAV", "/r/T2.WAV", "/r/T3.WAV"]);
  });

  it("collapses to ONE lane, because end-to-end clips do not overlap", () => {
    // The 14-lane Zoom stack disappears as arithmetic rather than as a special case: this
    // is `stackClips` on the same spans the component gets, with nothing else in between.
    const layout = sourceSpans(untimedDrop(), {});
    const rec = layout.tracks.find((t) => t.device.id === "rec")!;
    expect(stackClips(rec.spans)).toHaveLength(1);
  });

  it("starts a device's strip where its own last PLACED clip ended", () => {
    // A card that is half timed and half not reads as one continuous strip, rather than as
    // a pile at the start sitting on top of the clips that were placed.
    const scan = untimedDrop();
    scan.files.push(file({ file: "/a/C9.MP4", device: "cam-a", duration_seconds: 45 }));
    const layout = sourceSpans(scan, {});
    const cam = layout.tracks.find((t) => t.device.id === "cam-a")!;
    const c9 = cam.spans.find((s) => s.file === "/a/C9.MP4")!;
    // C1 runs 0–120 s, C2 runs 300–360 s. The untimed take follows C2.
    expect(c9.startMs).toBe(360_000);
    expect(c9.endMs).toBe(405_000);
    expect(stackClips(cam.spans)).toHaveLength(1);
  });

  it("starts at timeline zero for a device that has nothing placed", () => {
    const layout = sourceSpans(untimedDrop(), {});
    const rec = layout.tracks.find((t) => t.device.id === "rec")!;
    expect(rec.spans[0].startMs).toBe(0);
  });

  it("grows contentBounds only by what a device's strip actually adds", () => {
    // R2, as an assertion rather than as a hope. The session here is 360 s and the untimed
    // recorder's strip is 60 s, laid from zero — so the drawn span is still the session's.
    const layout = sourceSpans(untimedDrop(), {});
    const all = layout.tracks.flatMap((t) => t.spans);
    expect(contentBounds(all).spanMs).toBe(360_000);

    // …and when a device's strip DOES run past the session, the span grows to hold it,
    // because a clip drawn outside the bounds would be a clip nobody can scroll to.
    const scan = untimedDrop();
    scan.files.push(file({ file: "/r/T4.WAV", device: "rec", duration_seconds: 600 }));
    const grown = sourceSpans(scan, {});
    expect(contentBounds(grown.tracks.flatMap((t) => t.spans)).spanMs).toBe(660_000);
  });

  it("still stacks two genuinely overlapping PLACED clips into two lanes", () => {
    // The guard on the guard: D-068 must not turn the real overlap case into one row.
    const layout = sourceSpans(
      manifest(
        [device("cam-a")],
        [
          file({
            file: "/a/C1.MP4",
            device: "cam-a",
            creation_time: "2026-08-09T10:00:00Z",
            duration_seconds: 600,
          }),
          file({
            file: "/a/C2.MP4",
            device: "cam-a",
            creation_time: "2026-08-09T10:01:00Z",
            duration_seconds: 600,
          }),
        ],
      ),
      {},
    );
    expect(stackClips(layout.tracks[0].spans)).toHaveLength(2);
  });
});

// ── D-071: a stamp from another day is named, not removed ───────────────────────────────

describe("files stamped outside the session", () => {
  const strayDrop = () =>
    manifest(
      [device("cam-a"), device("drone")],
      [
        file({
          file: "/a/C1.MP4",
          device: "cam-a",
          creation_time: "2026-07-25T10:00:00Z",
          duration_seconds: 600,
        }),
        file({
          file: "/a/C2.MP4",
          device: "cam-a",
          creation_time: "2026-07-25T10:30:00Z",
          duration_seconds: 600,
        }),
        file({
          file: "/d/DJI_0075.MP4",
          device: "drone",
          creation_time: "2023-06-13T20:43:05Z",
          duration_seconds: 84,
        }),
        file({
          file: "/d/DJI_0076.MP4",
          device: "drone",
          creation_time: "2023-06-13T20:46:12Z",
          duration_seconds: 230,
        }),
      ],
    );

  it("keeps them out of `unknownStart` — they are a different sentence", () => {
    const layout = sourceSpans(strayDrop(), {});
    expect([...layout.outsideWindow].sort()).toEqual(["/d/DJI_0075.MP4", "/d/DJI_0076.MP4"]);
    expect(layout.unknownStart.size).toBe(0);
  });

  it("names the day they claim, so the line can say it out loud", () => {
    const layout = sourceSpans(strayDrop(), {});
    expect(layout.outsideWindowDays).toHaveLength(1);
    const day = new Date(layout.outsideWindowDays[0]);
    expect(day.getFullYear()).toBe(2023);
    expect(day.getMonth()).toBe(5);
    expect(day.getDate()).toBe(13);
  });

  it("lists more than one outlier day when a drop has more than one", () => {
    const scan = strayDrop();
    scan.devices.push(device("rec", "audio"));
    scan.files.push(
      file({
        file: "/r/200101_001.WAV",
        device: "rec",
        date_tag: "2020-01-01",
        creation_time: "00:01:58",
        duration_seconds: 30,
      }),
    );
    const layout = sourceSpans(scan, {});
    expect(layout.outsideWindowDays).toHaveLength(2);
    // Ascending, so the line reads in the order a calendar does.
    expect(layout.outsideWindowDays[0]).toBeLessThan(layout.outsideWindowDays[1]);
  });

  it("removes nothing — every file is still on a track", () => {
    // §7.3, and D-071 explicitly: naming a stray folder is the app's job, deciding what to
    // do about it is the operator's (D-062's per-file removal already exists).
    const layout = sourceSpans(strayDrop(), {});
    expect(spansOf(layout).size).toBe(4);
    const drone = layout.tracks.find((t) => t.device.id === "drone")!;
    expect(drone.spans).toEqual([
      { file: "/d/DJI_0075.MP4", startMs: 0, endMs: 84_000 },
      { file: "/d/DJI_0076.MP4", startMs: 84_000, endMs: 314_000 },
    ]);
  });

  it("does not let a rejected stamp define the origin", () => {
    const layout = sourceSpans(strayDrop(), {});
    expect(spansOf(layout).get("/a/C1.MP4")!.startMs).toBe(0);
    expect(spansOf(layout).get("/a/C2.MP4")!.startMs).toBe(30 * 60 * 1000);
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

    const layout = sourceSpans(scan, {});

    // Since D-071 it is named rather than merely "unknown": it HAS a stamp, from 1970.
    expect([...layout.outsideWindow]).toEqual(["/d/C3.MP4"]);
    const startOf = (file: string) => spansOf(layout).get(file)!.startMs;
    // The two real cards keep their true ten-minute separation, and the earliest of THEM
    // is zero — the dud does not get to define the origin.
    expect(startOf("/a/C1.MP4")).toBe(0);
    expect(startOf("/b/C2.MP4")).toBe(10 * 60 * 1000);
    // …and the dud lays out on its own row, from zero, because that device has nothing
    // placed to follow.
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
    const layout = sourceSpans(scan, {});
    expect(layout.unknownStart.size).toBe(0);
    expect(layout.outsideWindow.size).toBe(0);
    expect(spansOf(layout).get("/b/C2.MP4")!.startMs).toBe(6 * 60 * 60 * 1000);
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
    expect([...sourceSpans(scan, {}).outsideWindow]).toEqual(["/a/C1.MP4"]);
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
    expect([...sourceSpans(scan, {}).outsideWindow]).toEqual(["/dud.MP4"]);
  });

  it("leaves a single stamped file alone — one clock cannot contradict itself", () => {
    const scan = manifest(
      [device("cam-a")],
      [file({ file: "/a/C1.MP4", device: "cam-a", creation_time: "1970-01-01T00:00:00Z" })],
    );
    // Absurd on its face, but there is nothing to compare it with, and it positions
    // nothing: it is the origin, it sits at zero, and the sync is about to answer anyway.
    const layout = sourceSpans(scan, {});
    expect(layout.outsideWindow.size).toBe(0);
    expect(layout.unknownStart.size).toBe(0);
    expect(layout.timeSource.get("/a/C1.MP4")).toBe("container");
  });
});

// ── V05-W5 sweep, R2: what the sequential strip costs the content span ─────────────────
//
// W3 shipped the per-device strip after measuring +0.7 % on the owner's real corpus, where
// every device has *most* of its files placed and only a handful trailing. That is the
// benign shape. This block measures the OTHER one — a device with nothing placed at all and
// a long total — so the number is on record before it is ever a surprise, and so a
// regression that made it far worse would fail rather than merely look odd on screen.

describe("a device with EVERYTHING unplaced and a long total (R2)", () => {
  const SESSION_MS = 4 * 3600_000; // the wedding itself: four hours of timed cameras
  const MIXER_FILES = 11;
  const MIXER_EACH_MS = 26 * 60_000; // ~26 min per file, as the owner's mixer writes them
  const MIXER_TOTAL_MS = MIXER_FILES * MIXER_EACH_MS; // 4 h 46 min — LONGER than the shoot

  function drop() {
    const files: FileEntry[] = [
      file({
        file: "/FUJI/A.MOV",
        device: "fuji",
        creation_time: "2026-07-25T10:00:00Z",
        duration_seconds: 600,
      }),
      file({
        file: "/FUJI/B.MOV",
        device: "fuji",
        creation_time: new Date(Date.parse("2026-07-25T10:00:00Z") + SESSION_MS - 600_000).toISOString(),
        duration_seconds: 600,
      }),
    ];
    for (let i = 0; i < MIXER_FILES; i += 1) {
      files.push(
        file({
          file: `/MIKSER/take${String(i).padStart(2, "0")}.wav`,
          device: "mikser",
          duration_seconds: MIXER_EACH_MS / 1000,
        }),
      );
    }
    return sourceSpans(manifest([device("fuji"), device("mikser", "audio")], files), {});
  }

  it("the strip starts at zero and runs its own length — nothing is invented", () => {
    const spans = spansOf(drop());
    expect(spans.get("/MIKSER/take00.wav")).toEqual({
      file: "/MIKSER/take00.wav",
      startMs: 0,
      endMs: MIXER_EACH_MS,
    });
    expect(spans.get("/MIKSER/take10.wav")!.endMs).toBe(MIXER_TOTAL_MS);
  });

  it("MEASURED: the content span becomes the strip's length, +19 % over the session", () => {
    const layout = drop();
    const spanMs = contentBounds(layout.tracks.flatMap((t) => t.spans)).spanMs;
    expect(spanMs).toBe(MIXER_TOTAL_MS);
    const stretch = spanMs / SESSION_MS - 1;
    expect(stretch).toBeGreaterThan(0.15);
    expect(stretch).toBeLessThan(0.25);
    // The bound that actually matters, and the reason this is not being "fixed": the strip
    // can only ever be as long as the material it is made of, so the worst case is the sum
    // of one device's own durations — never the 1.8 × 10¹² ms a dead camera clock used to
    // produce (D-071's opening paragraph). Fit zoom stays usable by construction.
    expect(spanMs).toBeLessThanOrEqual(SESSION_MS + MIXER_TOTAL_MS);
  });

  it("the fit zoom that follows is still a working zoom, not a clamped one", () => {
    const layout = drop();
    const { spanMs } = contentBounds(layout.tracks.flatMap((t) => t.spans));
    // 1150 px of viewport over the stretched span: the mixer strip costs roughly a fifth of
    // the horizontal resolution, and every clip is still drawn at a real width.
    const pxPerMs = (1150 - 24) / spanMs;
    expect(MIXER_EACH_MS * pxPerMs).toBeGreaterThan(24); // wider than MIN_WAVEFORM_PX
    expect(600_000 * pxPerMs).toBeGreaterThan(24); // …and so is a ten-minute camera clip
  });

  it("still one lane, however long the strip is — end to end cannot overlap", () => {
    const mixer = drop().tracks.find((t) => t.device.id === "mikser")!;
    expect(stackClips(mixer.spans)).toHaveLength(1);
  });

  it("a device with SOME clips placed anchors its strip on them, not on zero", () => {
    // The benign shape W3 measured, kept beside the pathological one so the difference is
    // visible: the strip is an extension of the device's own row, and only what hangs off
    // the END of the last placed clip can stretch the drop at all.
    const layout = sourceSpans(
      manifest(
        [device("fuji")],
        [
          file({
            file: "/FUJI/A.MOV",
            device: "fuji",
            creation_time: "2026-07-25T10:00:00Z",
            duration_seconds: 600,
          }),
          file({
            file: "/FUJI/B.MOV",
            device: "fuji",
            creation_time: "2026-07-25T11:00:00Z",
            duration_seconds: 600,
          }),
          file({ file: "/FUJI/C.MOV", device: "fuji", duration_seconds: 300 }),
        ],
      ),
      {},
    );
    const spans = spansOf(layout);
    expect(spans.get("/FUJI/C.MOV")).toEqual({
      file: "/FUJI/C.MOV",
      startMs: 4200_000, // where B ended (1 h + 10 min)
      endMs: 4500_000,
    });
    expect(contentBounds(layout.tracks.flatMap((t) => t.spans)).spanMs).toBe(4500_000);
  });
});

// ── The origin, as an absolute moment (V06-G3, D-092 ⑧) ───────────────────────────────────
//
// `sourceSpans` has always subtracted the earliest placed recording time from every span; what
// is new is that it SAYS what that number was, so the ruler can print the day's own clock over
// the boxes instead of an elapsed count from a zero the app chose. Returned rather than
// recomputed upstream, because the ruler's labels and the boxes' positions are the same claim
// and two derivations of it are two things that can disagree.
describe("the layout's origin epoch", () => {
  it("is the earliest placed recording time, and is where span zero sits", () => {
    const layout = sourceSpans(
      manifest(
        [device("fuji")],
        [
          file({
            file: "/FUJI/B.MOV",
            device: "fuji",
            creation_time: "2026-07-25T11:00:00Z",
            duration_seconds: 600,
          }),
          file({
            file: "/FUJI/A.MOV",
            device: "fuji",
            creation_time: "2026-07-25T10:00:00Z",
            duration_seconds: 600,
          }),
        ],
      ),
      {},
    );
    expect(layout.originMs).toBe(Date.parse("2026-07-25T10:00:00Z"));
    // …and it really is t=0: the file that supplied it starts there.
    expect(spansOf(layout).get("/FUJI/A.MOV")?.startMs).toBe(0);
  });

  it("is null when the ladder timed nothing — zero is an order, not a moment", () => {
    const layout = sourceSpans(
      manifest(
        [device("johnny")],
        [
          file({ file: "/JOHNNY/MUSIC_01.WAV", device: "johnny", duration_seconds: 300 }),
          file({ file: "/JOHNNY/MUSIC_02.WAV", device: "johnny", duration_seconds: 300 }),
        ],
      ),
      {},
    );
    expect(layout.originMs).toBeNull();
  });

  it("moves when the file that anchored it is taken out of the drop", () => {
    // D-062's removal is applied by the caller (it filters the manifest), and the origin has
    // to follow — a lens-cap take with the earliest stamp anchoring a drop it is no longer
    // part of is the same bug in the ruler that it was in the boxes.
    const early = file({
      file: "/FUJI/A.MOV",
      device: "fuji",
      creation_time: "2026-07-25T10:00:00Z",
      duration_seconds: 600,
    });
    const late = file({
      file: "/FUJI/B.MOV",
      device: "fuji",
      creation_time: "2026-07-25T11:00:00Z",
      duration_seconds: 600,
    });
    expect(sourceSpans(manifest([device("fuji")], [early, late]), {}).originMs).toBe(
      Date.parse("2026-07-25T10:00:00Z"),
    );
    expect(sourceSpans(manifest([device("fuji")], [late]), {}).originMs).toBe(
      Date.parse("2026-07-25T11:00:00Z"),
    );
  });
});
