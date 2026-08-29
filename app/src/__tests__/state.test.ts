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


// ---- Per-file removal + background pre-analysis (V04-U4, D-062) ---------------------

const CAM = "/x/C0001.MP4";
const WAV = "/x/Z.WAV";
const BROKEN = "/x/broken.mp4";

/** The same manifest with one unreadable file the scan reported but could not use. */
const manifestWithProblem: ScanManifest = {
  ...manifest,
  unsynced: [{ file: BROKEN, reason: "decode_error" }],
};

function toSourcesWith(m: ScanManifest): AppState {
  let s = reducer(initialState, { type: "inputs/add", paths: ["/x"] });
  s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest: m });
  return s;
}

describe("removing files from the run (D-062)", () => {
  it("an excluded file joins the excluded list", () => {
    const s = reducer(toSources(), { type: "files/exclude", file: CAM });
    expect(s.excluded).toEqual([CAM]);
  });

  it("excluding twice is idempotent — the same state object comes back", () => {
    const once = reducer(toSources(), { type: "files/exclude", file: CAM });
    const twice = reducer(once, { type: "files/exclude", file: CAM });
    expect(twice).toBe(once);
    expect(twice.excluded).toEqual([CAM]);
  });

  it("restoring a file that was never excluded changes nothing", () => {
    const s = toSources();
    expect(reducer(s, { type: "files/restore", file: CAM })).toBe(s);
  });

  it("the file's override goes with it, and does not come back on restore", () => {
    // A device assignment for a file nobody is syncing is a claim about a run that will
    // not happen — and one that would silently reappear when the file did.
    let s = reducer(toSources(), { type: "override/set", file: CAM, device: "rec" });
    s = reducer(s, { type: "files/exclude", file: CAM });
    expect(s.overrides[CAM]).toBeUndefined();
    s = reducer(s, { type: "files/restore", file: CAM });
    expect(s.overrides[CAM]).toBeUndefined();
    expect(s.excluded).toEqual([]);
  });

  it("removing the reference file clears the star", () => {
    // Otherwise the run would name a reference the engine was told to skip, and would
    // quietly pick its own instead — a decision the operator never saw being taken.
    let s = reducer(toSources(), { type: "reference/set", file: WAV });
    s = reducer(s, { type: "files/exclude", file: WAV });
    expect(s.reference).toBeNull();
  });

  it("removing a DIFFERENT file leaves the star alone", () => {
    let s = reducer(toSources(), { type: "reference/set", file: WAV });
    s = reducer(s, { type: "files/exclude", file: CAM });
    expect(s.reference).toBe(WAV);
  });

  it("excluding and restoring both mark a shown result stale", () => {
    let s = reducer(toResult(), { type: "files/exclude", file: CAM });
    expect(s.phase.name === "result" && s.phase.stale).toBe(true);

    // And again on the way back: the run stored is one this file was not part of.
    s = reducer(toResult(), { type: "files/exclude", file: CAM });
    s = { ...s, phase: { ...(s.phase as Extract<AppState["phase"], { name: "result" }>), stale: false } };
    s = reducer(s, { type: "files/restore", file: CAM });
    expect(s.phase.name === "result" && s.phase.stale).toBe(true);
  });

  it("a removal before any sync has nothing to mark stale", () => {
    const s = reducer(toSources(), { type: "files/exclude", file: CAM });
    expect(s.phase.name).toBe("sources");
  });

  it("a re-scan keeps exclusions the scan still knows about — including problem files", () => {
    let s = toSourcesWith(manifestWithProblem);
    s = reducer(s, { type: "files/exclude", file: BROKEN });
    s = reducer(s, { type: "files/exclude", file: CAM });
    s = reducer(s, { type: "inputs/add", paths: ["/more"] });
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest: manifestWithProblem });
    // Both survive: one is a scanned file, the other a reported problem file. The panel
    // shows a row for each, so an exclusion for each must still be actionable.
    expect(s.excluded.sort()).toEqual([BROKEN, CAM].sort());
  });

  it("a re-scan prunes an exclusion for a path the scan no longer reports at all", () => {
    let s = toSourcesWith(manifestWithProblem);
    s = reducer(s, { type: "files/exclude", file: BROKEN });
    s = reducer(s, { type: "inputs/add", paths: ["/more"] });
    // This scan found neither the file nor the problem — the card is gone.
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
    expect(s.excluded).toEqual([]);
  });

  it("clearing the inputs forgets the exclusions", () => {
    // An `excluded` list surviving "clear all" would silently filter the NEXT drop.
    let s = reducer(toSources(), { type: "files/exclude", file: CAM });
    s = reducer(s, { type: "inputs/clear" });
    expect(s.excluded).toEqual([]);
    expect(s.prewarm).toEqual({});
  });

  it("removing the last root forgets them too", () => {
    let s = reducer(toSources(), { type: "files/exclude", file: CAM });
    s = reducer(s, { type: "inputs/removeRoot", path: "/x" });
    expect(s.phase.name).toBe("empty");
    expect(s.excluded).toEqual([]);
  });
});

describe("background pre-analysis bookkeeping (D-062)", () => {
  it("a scan starts every file pending", () => {
    expect(toSources().prewarm).toEqual({ [CAM]: "pending", [WAV]: "pending" });
  });

  it("an excluded file is not prewarmed across a re-scan", () => {
    // It is not part of the run, so decoding it is work nobody asked for — and a clip
    // that is not drawn cannot be waiting for anything.
    let s = reducer(toSources(), { type: "files/exclude", file: CAM });
    s = reducer(s, { type: "inputs/add", paths: ["/more"] });
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
    expect(s.prewarm).toEqual({ [WAV]: "pending" });
  });

  it("excluding a file drops it from the prewarm map immediately", () => {
    const s = reducer(toSources(), { type: "files/exclude", file: CAM });
    expect(CAM in s.prewarm).toBe(false);
    expect(s.prewarm[WAV]).toBe("pending");
  });

  it("prewarm:file records ready and failed per file", () => {
    let s = reducer(toSources(), { type: "prewarm/file", file: CAM, ok: true });
    s = reducer(s, { type: "prewarm/file", file: WAV, ok: false });
    expect(s.prewarm).toEqual({ [CAM]: "ready", [WAV]: "failed" });
  });

  it("an event for a file this scan does not know about is ignored", () => {
    // A late event from a superseded pass. Inventing an entry would leave a status
    // behind for a clip that does not exist.
    const s = toSources();
    expect(reducer(s, { type: "prewarm/file", file: "/x/GONE.MP4", ok: true })).toBe(s);
  });

  it("prewarm/progress carries the aggregate tick and settling clears it", () => {
    const sources = toSources();
    let s = reducer(sources, { type: "prewarm/progress", completed: 1, total: 2 });
    expect(s.prewarmProgress).toEqual({ completed: 1, total: 2 });
    s = reducer(s, { type: "prewarm/settled", seq: sources.scanSeq, reason: "done" });
    expect(s.prewarmProgress).toBeNull();
  });

  it("a pass that FINISHED turns what is still pending into failed and leaves ready alone", () => {
    // React batches updates within one task, so the LAST file's `prewarm:file` can land
    // in the same batch as the promise resolving. Wiping the map here would erase that
    // file's `ready` before any component saw it — and the waveform it had just written
    // would never be read.
    const sources = toSources();
    let s = reducer(sources, { type: "prewarm/file", file: CAM, ok: true });
    s = reducer(s, { type: "prewarm/settled", seq: sources.scanSeq, reason: "done" });
    expect(s.prewarm).toEqual({ [CAM]: "ready", [WAV]: "failed" });
  });

  it("settling an already-settled pass is a no-op", () => {
    const sources = toSources();
    const seq = sources.scanSeq;
    const s = reducer(reducer(sources, { type: "prewarm/settled", seq, reason: "done" }), {
      type: "prewarm/settled",
      seq,
      reason: "done",
    });
    expect(reducer(s, { type: "prewarm/settled", seq, reason: "done" })).toBe(s);
  });

  // ── V05-W1 (D-064): a cancelled pass is not a failed one ────────────────────────────
  //
  // The semantics of `prewarm/settled` genuinely changed here, and the old tests were
  // updated rather than worked around: the action now carries WHY the pass ended, because
  // "it finished and never got to these files" and "it was shoved aside before it could
  // look" are different facts with different right answers, and the first build gave both
  // the same one. It cost the owner a 386-file wedding wearing a rebuild button on every
  // clip.

  it("a CANCELLED pass deletes what was still pending instead of failing it", () => {
    // Preempted by a sync, superseded by a newer drop, or refused the D-046 slot. It never
    // formed an opinion about the files it had not reached — and neither has the app. An
    // absent entry is "no opinion"; `failed` would be an invention, and the invention is
    // what puts a rebuild control on a clip whose waveform is being built right now.
    const sources = toSources();
    let s = reducer(sources, { type: "prewarm/file", file: CAM, ok: true });
    s = reducer(s, { type: "prewarm/settled", seq: sources.scanSeq, reason: "cancelled" });
    expect(s.prewarm).toEqual({ [CAM]: "ready" });
    expect(WAV in s.prewarm).toBe(false);
  });

  it("a cancelled pass still leaves a file it genuinely could not decode failed", () => {
    // `prewarm:file { ok: false }` is a verdict the pass DID reach. Cancelling what came
    // after it does not retract it.
    const sources = toSources();
    let s = reducer(sources, { type: "prewarm/file", file: CAM, ok: false });
    s = reducer(s, { type: "prewarm/settled", seq: sources.scanSeq, reason: "cancelled" });
    expect(s.prewarm).toEqual({ [CAM]: "failed" });
  });

  it("a settlement that arrives after Sync was pressed cannot touch the map at all", () => {
    // The exact order of the owner's screenshot: `sync/start` marks every unanalysed file
    // `pending` (the run is analysing them), and only THEN does the preempted pass's
    // rejection come back. `sources` is the only phase a live pre-analysis belongs to —
    // the same rule `prewarm/progress` follows, and for the same reason.
    const sources = toSources();
    const syncing = reducer(sources, { type: "sync/start" });
    expect(syncing.prewarm).toEqual({ [CAM]: "pending", [WAV]: "pending" });

    for (const reason of ["done", "cancelled"] as const) {
      const after = reducer(syncing, { type: "prewarm/settled", seq: syncing.scanSeq, reason });
      expect(after).toBe(syncing);
    }
  });
});

// ── V05-W1 (D-064): a sync IS the analysis ────────────────────────────────────────────
//
// `run_sync` extracts the analysis audio for every file in the run. While it runs, an
// unanalysed file genuinely is being analysed — so `pending` is not a workaround for the
// settled-storm above, it is the fact that makes the storm impossible: there is nothing
// left for a dying prewarm to turn into a rebuild button. And when the run ends, the map
// stops claiming anything at all, because the truth is now in the cache and every clip can
// go and read it (`App.tsx` drops the store's memos on the same event).

describe("the sync's own analysis (V05-W1)", () => {
  it("sync/start marks every non-ready file pending, even when the map is empty", () => {
    // Empty is the real case, not a contrived one: the pass was cancelled by this very
    // Sync press, and cancelling deletes. Rebuilding from the manifest rather than from the
    // old map is what makes the two orderings agree.
    const sources = toSources();
    const emptied = reducer(sources, {
      type: "prewarm/settled",
      seq: sources.scanSeq,
      reason: "cancelled",
    });
    expect(emptied.prewarm).toEqual({});

    expect(reducer(emptied, { type: "sync/start" }).prewarm).toEqual({
      [CAM]: "pending",
      [WAV]: "pending",
    });
  });

  it("sync/start leaves an already-analysed file alone", () => {
    // Its analysis is written; the run will find it there. Saying "pending" would put an
    // «analyserer …» line over a waveform that is already drawn.
    const sources = toSources();
    const s = reducer(sources, { type: "prewarm/file", file: CAM, ok: true });
    expect(reducer(s, { type: "sync/start" }).prewarm).toEqual({
      [CAM]: "ready",
      [WAV]: "pending",
    });
  });

  it("sync/start does not claim to be analysing a file that was taken out of the run", () => {
    const s = reducer(toSources(), { type: "files/exclude", file: CAM });
    expect(reducer(s, { type: "sync/start" }).prewarm).toEqual({ [WAV]: "pending" });
  });

  it("sync/done stops claiming anything", () => {
    // Left standing, every entry would keep a clip on «analyserer …» forever — the run that
    // was doing the analysing is over.
    const s = reducer(reducer(toSources(), { type: "sync/start" }), {
      type: "sync/done",
      outcome,
    });
    expect(s.prewarm).toEqual({});
    expect(s.prewarmProgress).toBeNull();
  });

  it("a cancelled or failed run stops claiming anything either", () => {
    // It wrote analysis for the files it got through and nothing for the rest. The only
    // honest way to say that is to stop saying anything and let each clip read the cache.
    const s = reducer(reducer(toSources(), { type: "sync/start" }), {
      type: "sync/failed",
      error: { kind: "notice", text: "avbrutt" },
    });
    expect(s.phase.name).toBe("sources");
    expect(s.prewarm).toEqual({});
  });
});

// ── V04-U5 QA: a superseded pass must not speak for the drop that replaced it ──────────
//
// Two seams, both invisible from either side alone. `prewarm_analysis` claims the D-046
// activity slot with the ordinary guard, so only a `run_sync` may take it (D-059) — while
// the App fires exactly one pass per scan sequence and swallows every rejection. Drop a
// second folder mid-pass and the second `prewarm_analysis` was refused `busy:` in silence:
// the new drop got no background analysis at all, and the abandoned pass went on narrating
// the old one. `App.tsx` now cancels the running pass the moment a new scan starts; these
// two guards are what stops its dying words from being believed.

describe("a superseded pre-analysis pass (V04-U5)", () => {
  it("cannot tick the aggregate line for a drop that is no longer on screen", () => {
    const sources = toSources();
    // A second folder goes in: back to scanning, and the pass against the first drop is
    // still running for as long as it takes to notice it was cancelled.
    const scanning = reducer(sources, { type: "inputs/add", paths: ["/y"] });
    expect(scanning.phase.name).toBe("scanning");
    expect(reducer(scanning, { type: "prewarm/progress", completed: 3, total: 9 })).toBe(
      scanning,
    );
  });

  it("cannot tick it while a sync it was preempted by is running either", () => {
    const syncing = reducer(toSources(), { type: "sync/start" });
    expect(reducer(syncing, { type: "prewarm/progress", completed: 3, total: 9 })).toBe(
      syncing,
    );
  });

  it("cannot declare the NEW drop's files failed when it finally settles", () => {
    const first = toSources();
    // The next drop lands and starts its own pass; every file is pending again.
    let s = reducer(first, { type: "inputs/add", paths: ["/y"] });
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
    expect(s.prewarm).toEqual({ [CAM]: "pending", [WAV]: "pending" });

    // NOW the first pass's promise finally resolves. Its sequence is stale, so it settles
    // nothing: these files are waiting on the second pass, which is still running.
    const late = reducer(s, { type: "prewarm/settled", seq: first.scanSeq, reason: "done" });
    expect(late).toBe(s);
    expect(late.prewarm).toEqual({ [CAM]: "pending", [WAV]: "pending" });

    // The pass that actually belongs to this drop still settles it.
    expect(
      reducer(s, { type: "prewarm/settled", seq: s.scanSeq, reason: "done" }).prewarm,
    ).toEqual({
      [CAM]: "failed",
      [WAV]: "failed",
    });
  });
});

// ── V05-W5 sweep: the prewarm/sync/settle machine, run twice ───────────────────────────
//
// D-064 fixed the FIRST run. Everything below is the second one, and the shapes in between:
// a run that was cancelled, a run that broke, a drop that arrived mid-pass. The class of
// bug being hunted is a verdict from one run surviving into the next — which is exactly
// what D-064 was: a status invented by a dying pass, still on screen a run later.

describe("a second run inherits nothing from the first (V05-W5)", () => {
  it("no file is still 'failed' when the second sync starts", () => {
    let s = toSources();
    // The first pass ran to its end without reaching anything: every file is `failed`, and
    // every clip is correctly offering a rebuild.
    s = reducer(s, { type: "prewarm/settled", seq: s.scanSeq, reason: "done" });
    expect(Object.values(s.prewarm)).toEqual(["failed", "failed"]);

    s = reducer(s, { type: "sync/start" });
    // The sync IS the analysis (D-064), so nothing may still be claiming "failed".
    expect(Object.values(s.prewarm)).toEqual(["pending", "pending"]);
    s = reducer(s, { type: "sync/done", outcome });
    expect(s.prewarm).toEqual({});

    // And the second press starts from the same clean map, not from the first run's.
    s = reducer(s, { type: "sync/start" });
    expect(Object.values(s.prewarm)).toEqual(["pending", "pending"]);
  });

  it("a CANCELLED run leaves no claim behind for the run after it", () => {
    let s = toSources();
    s = reducer(s, { type: "sync/start" });
    s = reducer(s, { type: "cancel/requested" });
    expect(s.cancelling).toBe(true);
    s = reducer(s, {
      type: "sync/failed",
      error: { kind: "notice", text: "Avbrutt" },
    });
    expect(s.phase.name).toBe("sources");
    expect(s.cancelling).toBe(false);
    expect(s.banner).toEqual({ kind: "info", text: "Avbrutt" });
    // Nothing is claimed about any file: the run wrote analysis for what it reached and
    // nothing for the rest, and only the cache knows which is which.
    expect(s.prewarm).toEqual({});
    expect(s.prewarmProgress).toBeNull();

    s = reducer(s, { type: "sync/start" });
    expect(Object.values(s.prewarm)).toEqual(["pending", "pending"]);
    expect(s.banner).toBeNull(); // the cancel notice does not follow the new run
  });

  it("a run that BROKE leaves no claim behind either, and says so in red", () => {
    let s = toSources();
    s = reducer(s, { type: "sync/start" });
    s = reducer(s, { type: "sync/failed", error: { kind: "error", text: "ffmpeg døde" } });
    expect(s.banner).toEqual({ kind: "error", text: "ffmpeg døde" });
    expect(s.prewarm).toEqual({});
  });

  it("the preempted pass's rejection is inert whenever it finally lands", () => {
    // Three landing sites, all reachable: mid-sync, after a cancelled sync, and after a
    // completed one. None of them may put a status back on a clip.
    for (const after of ["syncing", "cancelled", "done"] as const) {
      let s = toSources();
      s = reducer(s, { type: "sync/start" });
      if (after === "cancelled") {
        s = reducer(s, { type: "sync/failed", error: { kind: "notice", text: "Avbrutt" } });
      } else if (after === "done") {
        s = reducer(s, { type: "sync/done", outcome });
      }
      const before = s.prewarm;
      for (const reason of ["done", "cancelled"] as const) {
        const settled = reducer(s, { type: "prewarm/settled", seq: s.scanSeq, reason });
        expect(settled.prewarm).toEqual(before);
      }
    }
  });

  it("a busy refusal and a preemption are the same ending as far as the map is concerned", () => {
    // `prewarmEndReason` (App.tsx) maps both `busy: …` and `cancelled` to `cancelled`; this
    // pins what the reducer then does with it — deletes, never invents.
    let s = toSources();
    s = reducer(s, { type: "prewarm/file", file: "/x/Z.WAV", ok: true });
    s = reducer(s, { type: "prewarm/settled", seq: s.scanSeq, reason: "cancelled" });
    expect(s.prewarm).toEqual({ "/x/Z.WAV": "ready" });
    expect("/x/C0001.MP4" in s.prewarm).toBe(false);
  });

  it("a new drop mid-pass is a different drop, and the old pass cannot speak for it", () => {
    let s = toSources();
    const oldSeq = s.scanSeq;
    // The operator drops a second folder while the first is still decoding.
    s = reducer(s, { type: "inputs/add", paths: ["/y"] });
    expect(s.phase.name).toBe("scanning");
    s = reducer(s, { type: "scan/done", seq: s.scanSeq, manifest });
    expect(Object.values(s.prewarm)).toEqual(["pending", "pending"]);

    // …and the abandoned pass finally settles, claiming to have finished.
    const late = reducer(s, { type: "prewarm/settled", seq: oldSeq, reason: "done" });
    expect(Object.values(late.prewarm)).toEqual(["pending", "pending"]);
    // Its progress ticks are NOT inert, and this pins the known gap rather than pretending
    // it is not there. `prewarm:progress` carries no sequence of its own (lib.rs emits a
    // plain `ProgressEvent`), so the reducer can only gate it on the phase — and once the
    // new scan has landed, the phase is `sources` again. Between `scan/done` and the
    // abandoned pass noticing its `cancel_prewarm`, one stale tick can move the line.
    // Recorded in KNOWN_LIMITATIONS: it is cosmetic, self-correcting within one file, and
    // the only honest fix is a sequence on the backend event — not a heuristic on `total`
    // dressed up as a rule.
    const ticked = reducer(s, { type: "prewarm/progress", completed: 300, total: 386 });
    expect(ticked.prewarmProgress).toEqual({ completed: 300, total: 386 });
  });

  it("a file excluded between two syncs is absent from the second run's map too", () => {
    let s = toSources();
    s = reducer(s, { type: "sync/start" });
    s = reducer(s, { type: "sync/done", outcome });
    s = reducer(s, { type: "files/exclude", file: "/x/C0001.MP4" });
    s = reducer(s, { type: "sync/start" });
    expect(Object.keys(s.prewarm)).toEqual(["/x/Z.WAV"]);
  });
});

/**
 * A hand-rebuild is an analysis (V06 review).
 *
 * The seam: `waveformStore` makes the `regenerate_analysis` call and holds the bytes
 * afterwards; `state.prewarm` is what the clip's blue (D-080) and the gutter's dot (D-083)
 * are drawn from. Only the first of the two used to hear that a rebuild had worked, so a
 * card the pass could not read drew its new waveforms inside grey boxes, under a dot still
 * reading «Lyden er ikke analysert».
 */
describe("a rebuilt analysis (V06 review)", () => {
  it("moves a failed file to ready", () => {
    let s = toSources();
    s = reducer(s, { type: "prewarm/file", file: "/x/C0001.MP4", ok: false });
    expect(s.prewarm["/x/C0001.MP4"]).toBe("failed");
    s = reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" });
    expect(s.prewarm["/x/C0001.MP4"]).toBe("ready");
    // Nobody else's status moved.
    expect(s.prewarm["/x/Z.WAV"]).toBe("pending");
  });

  it("gives an opinion to a file that has none — the case `prewarm/file` cannot", () => {
    // A cancelled pass DELETES its pending entries (D-064), and those are exactly the clips
    // that then offer the rebuild control. `prewarm/file`'s "must already be in the map"
    // guard is about late events from a superseded pass; this is the operator's own click.
    let s = toSources();
    s = reducer(s, { type: "prewarm/settled", seq: s.scanSeq, reason: "cancelled" });
    expect(s.prewarm).toEqual({});
    s = reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" });
    expect(s.prewarm).toEqual({ "/x/C0001.MP4": "ready" });
  });

  it("invents nothing for a path this drop does not contain", () => {
    const s = toSources();
    expect(reducer(s, { type: "analysis/regenerated", file: "/gone/ghost.mp4" })).toBe(s);
  });

  it("says nothing about a file the operator has taken out of the run", () => {
    // A removal drops the file's prewarm entry on purpose (D-062: a clip that is not drawn
    // cannot be waiting for anything), and a rebuild that happened to land afterwards must
    // not put it back — the map would then hold a verdict about a file that is not in the run.
    let s = toSources();
    s = reducer(s, { type: "files/exclude", file: "/x/C0001.MP4" });
    expect(reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" })).toBe(s);
  });

  it("is inert outside the sources phase, where the map is not read", () => {
    // While a sync runs the map describes the RUN's own extraction (D-064), and after one
    // every drawn clip is placed and the dot says so — neither is a place for a per-file
    // pre-analysis verdict to appear.
    for (const s of [reducer(toSources(), { type: "sync/start" }), toResult()]) {
      expect(reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" })).toBe(s);
    }
  });

  it("is idempotent", () => {
    let s = toSources();
    s = reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" });
    expect(reducer(s, { type: "analysis/regenerated", file: "/x/C0001.MP4" })).toBe(s);
  });
});
