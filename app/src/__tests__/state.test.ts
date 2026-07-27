import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../state";
import type { AppState } from "../state";
import type { ScanManifest, SyncOutcome } from "../types";

const manifest: ScanManifest = {
  schema: 1,
  devices: [
    { id: "cam-a", label: "A", kind: "video", files: ["/x/C0001.MP4"] },
    { id: "rec", label: "Zoom", kind: "audio", files: ["/x/Z.WAV"] },
  ],
  files: [
    {
      file: "/x/C0001.MP4",
      device: "cam-a",
      duration_seconds: 60,
      format_name: "mov",
      audio: { codec: "aac", sample_rate: 48000, channels: 2 },
      video: { codec: "h264", width: 1920, height: 1080, fps: "25/1" },
      creation_time: null,
    },
    {
      file: "/x/Z.WAV",
      device: "rec",
      duration_seconds: 300,
      format_name: "wav",
      audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 1 },
      video: null,
      creation_time: null,
    },
  ],
  unsynced: [],
};

const outcome: SyncOutcome = {
  result: {
    schema: 1,
    parameters: { analysis_rate: 12000, min_psr: 15 },
    reference: { file: "/x/Z.WAV", device: "rec" },
    devices: manifest.devices,
    placements: [],
    unsynced: [],
    sequence: { fps: "25/1", duration_seconds: 300 },
    warnings: [],
  },
  durations: { "/x/C0001.MP4": 60, "/x/Z.WAV": 300 },
};

function toSources(): AppState {
  let s = reducer(initialState, { type: "inputs/add", paths: ["/x"] });
  s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
  return s;
}

function toResult(): AppState {
  let s = toSources();
  s = reducer(s, { type: "sync/start" });
  s = reducer(s, { type: "sync/done", outcome });
  return s;
}

describe("phase machine", () => {
  it("adding inputs moves to scanning; scan/done lands on sources", () => {
    const s = toSources();
    expect(s.phase.name).toBe("sources");
  });

  it("a superseded scan's late result is ignored", () => {
    let s = reducer(initialState, { type: "inputs/add", paths: ["/x"] });
    const oldSeq = s.scanSeq;
    s = reducer(s, { type: "inputs/add", paths: ["/y"] }); // supersedes
    s = reducer(s, { type: "scan/done", seq: oldSeq, manifest });
    expect(s.phase.name).toBe("scanning"); // still waiting for the NEW scan
  });

  it("sync/start makes the old result unrepresentable", () => {
    let s = toResult();
    expect(s.phase.name).toBe("result");
    s = reducer(s, { type: "sync/start" });
    expect(s.phase.name).toBe("syncing");
    // There is no `outcome` field on the syncing phase — the old export button
    // cannot render during a run, by construction.
    expect("outcome" in s.phase).toBe(false);
  });

  it("cancel comes back as an info banner on sources, not an error", () => {
    let s = toSources();
    s = reducer(s, { type: "sync/start" });
    s = reducer(s, {
      type: "sync/failed",
      error: { kind: "notice", text: "Avbrutt." },
    });
    expect(s.phase.name).toBe("sources");
    expect(s.banner?.kind).toBe("info");
  });

  it("a real sync failure is an error banner", () => {
    let s = toSources();
    s = reducer(s, { type: "sync/start" });
    s = reducer(s, { type: "sync/failed", error: { kind: "error", text: "boom" } });
    expect(s.banner?.kind).toBe("error");
  });

  it("changing an override marks a result stale", () => {
    let s = toResult();
    s = reducer(s, { type: "override/set", file: "/x/C0001.MP4", device: "rec" });
    expect(s.phase.name).toBe("result");
    expect(s.phase.name === "result" && s.phase.stale).toBe(true);
    expect(s.overrides["/x/C0001.MP4"]).toBe("rec");
  });

  it("a re-scan prunes overrides and reference pointing at removed files", () => {
    let s = toSources();
    s = reducer(s, { type: "override/set", file: "/x/C0001.MP4", device: "rec" });
    s = reducer(s, { type: "reference/set", file: "/x/GONE.MP4" });
    s = reducer(s, { type: "inputs/add", paths: ["/more"] });
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
    expect(s.overrides["/x/C0001.MP4"]).toBe("rec"); // still scanned → kept
    expect(s.reference).toBeNull(); // gone → pruned
  });

  it("removing the last root returns to empty and clears cross-phase state", () => {
    let s = toSources();
    s = reducer(s, { type: "override/set", file: "/x/C0001.MP4", device: "rec" });
    s = reducer(s, { type: "inputs/removeRoot", path: "/x" });
    expect(s.phase.name).toBe("empty");
    expect(Object.keys(s.overrides)).toHaveLength(0);
  });

  it("banners clear on the next input transition", () => {
    let s = toSources();
    s = reducer(s, { type: "banner/set", banner: { kind: "ok", text: "eksportert" } });
    s = reducer(s, { type: "inputs/add", paths: ["/more"] });
    expect(s.banner).toBeNull();
  });
});
