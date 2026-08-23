import { describe, expect, it } from "vitest";
import type { FileEntry, ScanManifest } from "../../types";
import {
  groupDuration,
  groupFiles,
  isVideoGroup,
  problemFiles,
  removedFiles,
  skippedFiles,
  sourceCounts,
} from "./sourcesModel";

/**
 * The arithmetic behind the drop (V06-R2a, D-077).
 *
 * These rules used to be four `useMemo`s inside `SourcesPanel.tsx`, and the only way to state
 * them was to render a list and read it back — which is why the one that matters most (the
 * strip and the list agreeing about how many files are in the run) was asserted nowhere at
 * all. They are pure functions now, shared by the four places the panel's affordances landed
 * in, so the rules can be said directly.
 */

const CAM = "/Users/e2e/shoot/CamA/C0001.MP4";
const CAM2 = "/Users/e2e/shoot/CamA/C0002.MP4";
const WAV = "/Users/e2e/shoot/ZOOM0001.WAV";
const BROKEN = "/Users/e2e/shoot/broken.mp4";

function video(file: string, device: string, duration = 100): FileEntry {
  return {
    file,
    device,
    duration_seconds: duration,
    format_name: "mov,mp4",
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
    video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
    creation_time: null,
  } as FileEntry;
}

function audio(file: string, device: string, duration = 200): FileEntry {
  return {
    file,
    device,
    duration_seconds: duration,
    format_name: "wav",
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
    video: null,
    creation_time: null,
  } as FileEntry;
}

function manifest(over: Partial<ScanManifest> = {}): ScanManifest {
  return {
    schema: 1,
    devices: [
      { id: "cam-a", label: "Camera A", kind: "video", files: [CAM, CAM2] },
      { id: "rec", label: "Zoom recorder", kind: "audio", files: [WAV] },
    ],
    files: [video(CAM, "cam-a"), video(CAM2, "cam-a", 300), audio(WAV, "rec")],
    unsynced: [],
    ...over,
  } as ScanManifest;
}

const NONE: ReadonlySet<string> = new Set();

describe("groupFiles", () => {
  it("groups the drop under the devices the scan found, in the manifest's own order", () => {
    const groups = groupFiles(manifest(), {}, NONE);
    expect(groups.map((g) => g.device.id)).toEqual(["cam-a", "rec"]);
    expect(groups[0].files.map((f) => f.file)).toEqual([CAM, CAM2]);
  });

  it("an override moves the row, and a device the overlay empties disappears entirely", () => {
    // What the engine will do at sync time, done in the view first (D-027/D-028) — a heading
    // with nothing under it would claim a device that is not in the run.
    const groups = groupFiles(manifest(), { [WAV]: "cam-a" }, NONE);
    expect(groups.map((g) => g.device.id)).toEqual(["cam-a"]);
    expect(groups[0].files.map((f) => f.file)).toEqual([CAM, CAM2, WAV]);
  });

  it("a removed file leaves the group it was in (D-062)", () => {
    const groups = groupFiles(manifest(), {}, new Set([CAM, CAM2]));
    expect(groups.map((g) => g.device.id)).toEqual(["rec"]);
  });

  it("an override naming a device the manifest does not have drops the row rather than inventing one", () => {
    // The overlay is the operator's, and it can outlive the scan that produced the ids (a
    // re-scan of a different card). Silently keeping the file under its OLD device would put
    // it in a run the operator moved it out of.
    const groups = groupFiles(manifest(), { [WAV]: "cam-ghost" }, NONE);
    expect(groups.flatMap((g) => g.files.map((f) => f.file))).toEqual([CAM, CAM2]);
  });
});

describe("sourceCounts", () => {
  it("is the strip's «N filer · M enheter»", () => {
    expect(sourceCounts(manifest(), {}, NONE)).toEqual({ files: 3, devices: 2 });
  });

  it("counts after the exclusion filter, not before", () => {
    expect(sourceCounts(manifest(), {}, new Set([CAM2]))).toEqual({ files: 2, devices: 2 });
  });

  it("counts devices through the overlay, so an emptied one stops counting", () => {
    expect(sourceCounts(manifest(), { [WAV]: "cam-a" }, NONE)).toEqual({ files: 3, devices: 1 });
  });

  it("agrees with groupFiles, always — the strip and the list it opens are one claim (D-081)", () => {
    // The bug this exists to refuse: a 44 px line that says «3 filer · 2 enheter» over a panel
    // listing two files. The two derivations are separate on purpose (the strip needs this in
    // phases where no list is drawn), so the agreement has to be asserted rather than assumed.
    const cases: { overrides: Record<string, string>; excluded: Set<string> }[] = [
      { overrides: {}, excluded: new Set() },
      { overrides: {}, excluded: new Set([CAM]) },
      { overrides: { [WAV]: "cam-a" }, excluded: new Set() },
      { overrides: { [CAM]: "rec", [CAM2]: "rec" }, excluded: new Set([WAV]) },
      { overrides: {}, excluded: new Set([CAM, CAM2, WAV]) },
    ];
    for (const { overrides, excluded } of cases) {
      const groups = groupFiles(manifest(), overrides, excluded);
      const counts = sourceCounts(manifest(), overrides, excluded);
      expect(counts.files).toBe(groups.reduce((acc, g) => acc + g.files.length, 0));
      expect(counts.devices).toBe(groups.length);
    }
  });
});

describe("problemFiles", () => {
  it("is the scan's own refusals, minus what the operator already removed", () => {
    const m = manifest({ unsynced: [{ file: BROKEN, reason: "decode_error" }] });
    expect(problemFiles(m, NONE).map((u) => u.file)).toEqual([BROKEN]);
    expect(problemFiles(m, new Set([BROKEN]))).toEqual([]);
  });
});

describe("removedFiles", () => {
  it("keeps the order they were removed in, and carries what the scan knows about each", () => {
    const m = manifest({ unsynced: [{ file: BROKEN, reason: "decode_error" }] });
    const removed = removedFiles(m, new Set([CAM2, BROKEN]));
    expect(removed.map((r) => r.file)).toEqual([CAM2, BROKEN]);
    // A readable file has its entry; a problem file has no `FileEntry` at all, and its reason
    // is the only thing there is to show beside the name.
    expect(removed[0].entry?.duration_seconds).toBe(300);
    expect(removed[0].problem).toBeNull();
    expect(removed[1].entry).toBeNull();
    expect(removed[1].problem?.reason).toBe("decode_error");
  });

  it("names a path the manifest has never heard of rather than dropping it", () => {
    // A re-scan can come back without a file the operator had removed. The undo must still be
    // offered: losing the row would make the removal permanent by accident.
    const removed = removedFiles(manifest(), new Set(["/gone/ghost.mp4"]));
    expect(removed).toEqual([{ file: "/gone/ghost.mp4", entry: null, problem: null }]);
  });
});

describe("skippedFiles", () => {
  it("splits the walk's skips the way the one-sentence summary needs them (D-066)", () => {
    const m = manifest({
      skipped: [
        { file: "/a/DJI_0075.LRF", reason: "sidecar" },
        { file: "/a/DJI_0080.LRF", reason: "sidecar" },
        { file: "/a/IMG_4164.HEIC", reason: "still_image" },
      ],
    });
    expect(skippedFiles(m)).toMatchObject({ sidecars: 2, stills: 1 });
    expect(skippedFiles(m).files).toHaveLength(3);
  });

  it("an absent list is an empty one — an older manifest has no `skipped` field at all", () => {
    expect(skippedFiles(manifest())).toEqual({ files: [], sidecars: 0, stills: 0 });
  });
});

describe("the device head's two facts", () => {
  it("sums the group's own durations", () => {
    const [cam] = groupFiles(manifest(), {}, NONE);
    expect(groupDuration(cam)).toBe(400);
  });

  it("calls a group a camera when anything in it carries video", () => {
    const groups = groupFiles(manifest(), {}, NONE);
    expect(isVideoGroup(groups[0])).toBe(true);
    expect(isVideoGroup(groups[1])).toBe(false);
    // …and one video file among recordings is enough: the icon is about what the device is,
    // not about a majority vote of its files.
    const mixed = groupFiles(manifest(), { [CAM]: "rec" }, new Set([CAM2]));
    expect(isVideoGroup(mixed[0])).toBe(true);
  });
});
