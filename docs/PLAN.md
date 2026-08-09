# SundaySync — v1 Implementation Plan

> **Source of truth for v1.** Authored by Richard, 2026-07-27. Deviations from this document
> are recorded in [`DECISIONS.md`](DECISIONS.md); current progress is in
> [`STATUS.md`](STATUS.md).

**Audience:** Claude Opus 5 executing through Claude Code, phase by phase.
**Owner:** Richard (Sunday suite).
**Language:** UI is bilingual (Norwegian Bokmål + English). Code, comments, commits, and docs in English.

## 0. How to use this document

This is the single source of truth for v1. Work through the phases in §11 in order. Each phase has
acceptance criteria; do not start the next phase until the current one is green in CI. When a decision
is not covered here, prefer the simplest option that preserves determinism and testability, record it
in `DECISIONS.md`, and continue — do not block on questions unless the decision is irreversible
(file formats, result schema, public CLI flags).

## 1. Product definition (locked decisions)

SundaySync is a standalone desktop app (Windows + macOS) in the PluralEyes/Syncaila category: the user
drops an arbitrary pile of media from a multicamera shoot (church service, concert, event) into the app,
presses Sync, and gets a synchronized timeline exported as FCPXML for DaVinci Resolve.

Locked v1 decisions:

1. **Workflow:** standalone only — files in, synced timeline out. No NLE round-trip, no XML import.
2. **Export target:** DaVinci Resolve (current releases), via FCPXML. No other NLE in v1.
3. **Drift:** v1 measures and reports audio drift per clip; correction ships in v2. The engine must
   produce drift data good enough that v2 only adds the resampling step.
4. **License:** free, like SundayRec. No license system, no telemetry, no accounts. 100 % local processing.
5. **UI:** simple mode by default; advanced mode behind a toggle.
6. **Stack:** Tauri 2 + Rust + React (reuse SundayRec project conventions, ffmpeg sidecar bundling,
   i18n pattern, and Tauri updater setup). All DSP in Rust.
7. **Quality bar:** match or beat PluralEyes/Syncaila on sync accuracy and robustness for the target
   scenario (long church/event shoots, multiple cameras with start/stops, one external recorder/mixer
   feed, no timecode).

## 2. Non-goals for v1

- No drift correction, no time-stretching, no rendered/merged media output.
- No Premiere/FCP/Avid export, no NLE panels or plugins.
- No timecode-based sync (metadata is used only as a sanity check).
- No cloud anything.
- No editing features (trims, cuts, multicam clip creation) — SundaySync produces a sync map,
  Resolve does the editing.

## 3. Architecture overview

Cargo workspace + Tauri app. The engine must be fully usable and testable without the GUI.

```
sundaysync/
  crates/
    core/        # sundaysync-core: the entire engine (lib). No UI deps, no Tauri deps.
    cli/         # sundaysync CLI binary wrapping core. Used by CI, benchmarks, power users.
    fixturegen/  # synthetic test-media generator (dev tool, also a binary).
  app/           # Tauri 2 + React shell. Thin: invokes core, renders progress + results.
  fixtures/      # small generated fixtures committed for CI (audio-only, tiny)
  corpus/        # real footage benchmark sets (gitignored; lives on Richard's machine/NAS)
  docs/          # this plan, DECISIONS.md, STATUS.md
```

Pipeline (core):

```
scan → probe (ffprobe) → group by device → extract analysis audio (ffmpeg → PCM cache)
     → pairwise offset estimation (GCC-PHAT) → global placement + track assignment
     → drift measurement → SyncResult (JSON) → FCPXML export
```

Key principles:

- `core` exposes one entry point: `sync(SyncRequest) -> Result<SyncResult>` plus a progress callback
  and a cancellation token. CLI and Tauri both call this.
- **Determinism:** identical inputs (paths, contents, parameters) ⇒ byte-identical `SyncResult` JSON
  and FCPXML. No randomness, stable sort orders everywhere (sort by path as final tiebreaker).
- **Process isolation for decoding:** all media decoding happens in ffmpeg/ffprobe child processes.
  A corrupt file kills its child process, never the app; the file lands in `unsynced` with reason
  `decode_error`.
- **Streaming:** never load full-resolution media into memory. Analysis audio is downsampled PCM
  cached on disk and memory-mapped for FFT work.

## 4. Sync engine specification

### 4.1 Probe & scan

- Input: list of files and/or folders (recursive). Accept anything ffprobe can identify with an audio
  stream; video-only files (no audio) go straight to `unsynced` with reason `no_audio`.
- `ffprobe -print_format json -show_format -show_streams` per file, in a child process with a 30 s
  timeout. Collect: duration, codec, sample rate, channels, resolution, fps (as a rational),
  creation_time, and any camera/encoder metadata.
- Reject nothing by extension; reject only on probe failure.

### 4.2 Analysis audio extraction

- ffmpeg sidecar decodes each file's first audio stream to mono f32 PCM at 12 000 Hz
  (`-map 0:a:0 -ac 1 -ar 12000 -f f32le`). 12 kHz keeps speech/music transients while keeping FFTs
  cheap; it is an internal constant (`ANALYSIS_RATE`), not user-visible in simple mode.
- Cache file: `{cache_dir}/{blake3(abs_path, size, mtime, ANALYSIS_RATE)}.f32`. Cache hit ⇒ skip decode.
  This is what makes re-sync near-instant (Syncaila's "accelerated re-sync", ours for free).
- Cache dir defaults to the OS cache location; overridable (PluralEyes lesson: temp-space complaints
  were a top support issue). Footprint is ~48 KB/s ≈ 1–2 % of source size, so this is a non-issue —
  state that in the UI tooltip.
- Parallel decode: `min(4, physical_cores)` concurrent ffmpeg processes.

### 4.3 Pairwise offset estimation — GCC-PHAT

The core primitive is: given clip audio A and reference audio B, find the offset of A within B, with a
confidence score.

- **Method:** GCC-PHAT (generalized cross-correlation with phase transform) via `rustfft`. PHAT
  whitening makes matching robust to the exact problem we have: the same event captured by a mixer feed
  and a distant camera mic sound completely different (EQ, reverb, gain), but share phase structure.
- **Segmenting:** for clip A shorter than 45 s, correlate the whole clip. Otherwise take 5 segments of
  20 s spread evenly across A (always including one near the start and one near the end). Each segment
  is correlated against B independently.
- Reference-side FFT of B is computed once and cached in memory per sync run.
- **Sub-sample precision:** parabolic interpolation of the correlation peak. At 12 kHz one sample =
  0.083 ms, so integer-sample precision already beats one frame by two orders of magnitude;
  interpolation is cheap insurance.
- **Confidence:** peak-to-sidelobe ratio (PSR) of the correlation, combined across segments. Segment
  offsets must agree: median offset is the estimate; median absolute deviation (MAD) > 15 ms marks the
  clip inconsistent (candidate drift or bad match).
- **Accept threshold:** a single constant `MIN_PSR`, calibrated in Phase 3 against the synthetic suite
  to achieve zero false positives on the suite while keeping false negatives < 5 %. Exposed only in
  advanced mode.

### 4.4 Reference selection & global placement

- **Reference track:** the file with the longest audio duration among all inputs; ties broken by
  preferring dedicated audio files (wav/flac) over camera files, then by path sort. The reference is
  almost always the mixer/recorder feed in the target scenario. Advanced mode allows manual override.
- **Placement, pass 1:** every other clip is matched directly against the reference.
- **Placement, pass 2 (transitive):** clips that failed pass 1 are matched against already-placed clips
  (largest placed clips first, early exit on strong PSR). A transitive placement's confidence is the
  minimum along its chain.
- Clips still unmatched ⇒ `unsynced` with reason `low_confidence`. **Never place a clip below
  threshold** — a wrong sync is worse than an honest failure. This is the product's core stability
  promise.
- **Sanity check:** if a placement disagrees with file creation_time metadata by more than 10 minutes,
  keep the placement but attach a `metadata_mismatch` warning.
- **Same-device invariant:** clips from one device must not overlap in time (cameras record
  sequentially). An overlap forces the lower-confidence clip to `unsynced` with reason `device_overlap`.

### 4.5 Device grouping

- Heuristics in priority order: (1) explicit per-folder grouping if the user dropped folders,
  (2) camera/encoder metadata from probe, (3) filename pattern clustering (e.g. `C0###`, `DSC_####`,
  `GX01####`, `ZOOM####`, common prefix + counter), (4) container/codec/resolution/fps signature.
- Every file gets a device id; devices get human labels ("Sony A7 IV", "Mappe: Balkong", "Zoom H6").
  Advanced mode lets the user re-assign files between devices before syncing.

### 4.6 Drift measurement (v1 scope)

- For each placed clip with ≥ 3 segments: linear regression of (segment position in A, measured offset)
  ⇒ drift in ppm plus projected end-of-clip error in ms.
- Warn in UI when projected end error > 0.5 frame at the sequence frame rate. Copy: "Dette klippet
  driver X ms over lengden. Automatisk driftkorreksjon kommer i en senere versjon."
- Persist drift per clip in `SyncResult` — this is the v2 contract: v2 adds resampling using exactly
  this data, nothing upstream changes.

## 5. Result contract (`SyncResult` JSON, schema v1)

The stable boundary between engine, CLI, UI, and exporter. Version it from day one.

```json
{
  "schema": 1,
  "parameters": { "analysis_rate": 12000, "min_psr": 5.0 },
  "reference": { "file": "/abs/path/mixer.wav", "device": "zoom-h6" },
  "devices": [
    { "id": "cam-a", "label": "Sony A7 IV", "kind": "video", "files": ["..."] }
  ],
  "placements": [
    {
      "file": "/abs/path/C0012.MP4",
      "device": "cam-a",
      "offset_seconds": 1234.5678,
      "confidence": 0.94,
      "psr": 11.2,
      "drift_ppm": 18.3,
      "projected_end_error_ms": 41.0,
      "chain": ["reference"],
      "warnings": []
    }
  ],
  "unsynced": [
    { "file": "...", "reason": "low_confidence | no_audio | decode_error | device_overlap" }
  ],
  "sequence": { "fps": "25/1", "duration_seconds": 5400.0 },
  "warnings": []
}
```

Rules: absolute paths; seconds as f64 (internally the engine works in analysis samples, converting once
at the boundary); arrays sorted deterministically (devices by id, placements by offset then path).

## 6. FCPXML export specification (Resolve target)

- Generate FCPXML 1.10 with `quick-xml` (writer API, not string concatenation). One `.fcpxml` file,
  media referenced in place via percent-encoded `file://` URLs — never copy or move media.
- **Resources:** one `<format>` per unique (width, height, fps) using rational frame durations
  (`1001/30000s` etc.); one `<asset>` + `<media-rep>` per file. Sequence fps = the fps of the most common
  camera format; mixed-fps inputs are allowed (each asset keeps its own format) but add a `mixed_fps`
  warning.
- **Structure:** a full-length `<gap>` as the primary storyline; every clip attached as a connected
  `<asset-clip>` with `lane` numbers — video devices on positive lanes (one lane per device), audio on
  negative lanes (reference feed on lane −1, camera scratch audio muted by default via `role`/volume).
  Resolve imports this lane layout as separate tracks. If Phase 5 verification shows Resolve mishandles
  some construct, the fallback is secondary storylines per device — decide by testing, record in
  `DECISIONS.md`.
- **Timing precision:** audio placements use exact rational times (sub-frame); video clip boundaries
  snap to the sequence frame grid, with the residual (< half a frame) noted per clip in
  `SyncResult.warnings`. If Resolve import proves to quantize audio offsets to frames, accept frame
  precision for v1 and document it in `KNOWN_LIMITATIONS.md` — do not fight the importer.
- Clips are exported whole (start = 0, full duration). No trims in v1.
- Validate every generated file against the bundled FCPXML DTD in tests.

## 7. Stability requirements (v1's actual headline feature)

1. **No panics in `core`:** `unwrap`/`expect` forbidden outside tests (enforced with clippy lints in CI).
   All fallible paths return typed errors (`thiserror`).
2. **Crash isolation:** decoding/probing in child processes with timeouts; one bad file can never take
   down a run.
3. **Every input file is accounted for:** each ends in exactly one of `placements` or `unsynced` — an
   invariant checked by a debug assertion and a property test.
4. **Cancellation:** the token is checked between every unit of work; cancel must return within 2 s and
   leave only reusable cache files behind.
5. **Honest failure over silent wrongness:** below-threshold matches are never placed. The UI never
   shows green for anything the engine isn't confident about.
6. **Diagnostics:** structured logging via `tracing`; an "Export diagnostics" button produces a zip
   (log + `SyncResult` + probe manifests, no media) — same support pattern as SundayRec Lydhjelp.
7. **Long-run hygiene:** memory ceiling independent of shoot length (mmap analysis PCM; stream FFT
   input); a 20-hour, 200-file day must run in < 4 GB RSS.

## 8. Testing strategy

### 8.1 Synthetic fixtures (CI backbone)

`fixturegen` builds test shoots from a seed + spec, entirely deterministic:

- Start from base audio (generated: speech-like noise bursts + music-like tonal beds, plus a few
  committed CC0 recordings).
- Simulate devices: cut into clips with known ground-truth offsets; per device apply gain, EQ coloration,
  synthetic reverb, added crowd noise at set SNRs, and clock drift (resample by 1 ± n·10⁻⁶ for drift
  cases).
- Emit tiny real media (wav + small mp4 via ffmpeg) plus a `truth.json`.
- Suite tiers: `quick` (seconds, every CI run), `full` (minutes, nightly + pre-release): long files,
  4+ devices, start/stop patterns, loud ambience, near-silence, duplicate takes, files with no
  correlation at all (must land in unsynced).

### 8.2 Accuracy targets (release gates)

On the `full` synthetic suite:

- ≥ 95 % of syncable clips within ±10 ms of truth; 100 % of placed clips within ±1 frame.
- Zero false placements (clip placed > 1 frame from truth) at default threshold.
- Drift estimates within ±5 ppm of injected drift.
- Beat-PluralEyes benchmark: PluralEyes synced ~7 h of media in 4:24 on 2023 hardware; target ≤ that on
  comparable hardware, and near-instant on re-sync (warm cache).

### 8.3 Real corpus (Richard supplies)

- 3–5 complete services/events (all cameras + mixer feed) plus curated nasties: B-cam start/stops, loud
  band segments, clips that failed in PluralEyes/Syncaila historically.
- Ground truth established once: run engine → verify/adjust manually in Resolve → freeze as `truth.json`.
  Runs as a local/NAS benchmark (`cli bench corpus/`), not in GitHub CI. Regression = release blocker.

### 8.4 Other testing

- Property tests (`proptest`): random clip layouts ⇒ invariants (§7.3, no same-device overlap,
  deterministic output).
- Golden FCPXML tests: fixed `SyncResult` in ⇒ byte-identical XML out.
- Manual Resolve acceptance checklist (Phase 5): import on Windows + macOS, current Resolve; verify track
  layout, offsets on a known fixture, mixed-fps behavior, relink behavior, sub-frame audio handling.
- CI: GitHub Actions (like SundayRec) — lint + clippy + `quick` suite on every push (ubuntu runner, apt
  ffmpeg); Tauri bundle builds for Win/mac on tags; nightly `full` suite.

## 9. UI specification

**Simple mode (default)** — one screen, zero configuration:

1. Drop zone ("Slipp inn alt fra opptaket — video, lyd, hele mapper").
2. Auto-detected device summary (chips: "3 kameraer · 1 lydopptaker · 42 filer").
3. Big **Synkroniser** button → progress with stage names and per-file ticks; cancel button.
4. Result view: horizontal track lanes (one per device) with clip blocks colored green (confident) /
   yellow (placed with warnings: drift, metadata mismatch) / plus a red "Ikke synkronisert" shelf listing
   failures with plain-language reasons. Click a clip for details. (This is PluralEyes' loved
   color-coding, kept.)
5. **Eksporter til DaVinci Resolve** → save `.fcpxml` + a short "how to import" hint.

**Advanced mode (toggle):** re-assign files between devices; choose reference; adjust `MIN_PSR` and
segment count; set cache dir; re-sync single clips after re-grouping; export diagnostics zip. Advanced
settings persist per machine, never change simple-mode defaults.

Visual design follows the Sunday suite look; i18n (nb + en) with the SundayRec pattern. Result view is
informational, not an editor — no dragging clips in v1.

**Amendment (v0.3, D-051):** point 4's "horizontal track lanes" are superseded by an interactive
timeline. Same information, same colour language, same clip-detail dialog and same red unsynced shelf —
but laid out against a real time axis the operator can zoom, pan and scrub, with one track per device and
stacked sub-track rows where a device's own clips overlap. The percentage-of-widest-span layout the
original wording implied could not show a four-second offset inside a ninety-minute service at all. The
founding principle is retained, not revisited: zoom, pan and seek are read-mostly operations over a
result that already exists; nothing here writes back into `SyncResult`, and clips still do not drag.

## 10. Performance targets

- Cold sync of an 8 h / 100-file day: < 6 min on a modern 8-core laptop (decode-bound); warm-cache
  re-sync < 30 s.
- UI stays responsive throughout (all engine work off the main thread; progress events throttled to 10 Hz).
- Installer < 40 MB per platform excluding ffmpeg; reuse SundayRec's ffmpeg bundling + license notices.

## 11. Delivery phases

Each phase = one branch/PR, merged only with green CI and its acceptance criteria met. Update `STATUS.md`
at every phase end.

- **Phase 0 — Skeleton.** Workspace per §3, CI pipeline, clippy config (§7.1), empty `sync()` returning a
  stub `SyncResult`, CLI printing it. *Accept:* CI green on all three platforms' checks;
  `cargo run -p cli -- sync --help` works.
- **Phase 1 — Probe & inventory.** §4.1 + §4.5 device grouping. CLI `scan` command outputs the manifest.
  *Accept:* corrupt/zero-byte/video-only fixtures land in the right buckets; grouping correct on synthetic
  filename/metadata cases.
- **Phase 2 — Extraction & cache.** §4.2. *Accept:* cache hits skip ffmpeg (verified by process count);
  interrupted extraction leaves no corrupt cache entries; parallel decode saturates the file set.
- **Phase 3 — Offset engine.** §4.3 + fixturegen (§8.1) built first, then GCC-PHAT against it. Calibrate
  `MIN_PSR`. *Accept:* `quick` suite green; accuracy targets §8.2 met on the offset level; zero false
  positives.
- **Phase 4 — Placement & drift.** §4.4 + §4.6 + full `SyncResult`. Property tests live. *Accept:* full
  pipeline on synthetic multi-device shoots meets §8.2; invariants hold under proptest.
- **Phase 5 — FCPXML export.** §6 + golden tests + manual Resolve verification on both OSes; record
  findings in `DECISIONS.md`/`KNOWN_LIMITATIONS.md`. *Accept:* checklist §8.4 passes; a synthetic shoot
  imports into Resolve with correct layout and offsets.
- **Phase 6 — CLI complete + real corpus.** `sync`, `scan`, `bench` commands; corpus onboarding with
  Richard; fix what the corpus exposes. *Accept:* full corpus benchmark meets §8.2 with zero false
  placements; performance targets §10 met.
- **Phase 7 — Tauri app, simple mode.** §9 simple flow wired to core with progress + cancel. *Accept:*
  end-to-end drag-in → export on Win + mac using corpus material; cancel within 2 s; UI matches §9.
- **Phase 8 — Advanced mode + diagnostics.** *Accept:* re-grouping changes results as expected;
  diagnostics zip complete; settings persist.
- **Phase 9 — Release.** i18n complete, Tauri updater, installers, `KNOWN_LIMITATIONS.md`, landing copy.
  *Accept:* signed builds install and run clean on fresh Win/mac machines; v1.0 tagged.

## 12. V2 parking lot (do not build, do not block)

Drift correction (resample using §4.6 data; toggleable like PluralEyes 4.1) · Premiere export (FCP7 XML) ·
AAF · music-video takes mode · per-clip synced-audio media export · GPU FFT · project save/load of sync
sessions · Resolve DRT investigation.

## 13. Working agreements for Claude Code

1. **Test-first in `core`:** no engine feature without fixture coverage in the same PR.
2. **Never weaken an accuracy gate to make CI pass;** if a target seems wrong, stop and raise it with
   Richard.
3. New dependencies require a one-line justification in `DECISIONS.md`.
4. **Determinism is a test, not an aspiration:** the same-input-twice byte-equality check runs in CI from
   Phase 3 on.
5. Conventional commits; small PRs; `STATUS.md` always reflects reality.
6. Anything discovered about Resolve's importer behavior gets written down immediately — that knowledge is
   half this product's moat.
