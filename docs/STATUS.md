# Status

Per [`PLAN.md`](PLAN.md) §13.5, this file always reflects reality. Updated at every phase end.

**Phases 0–6 accepted. 7–8 rebuilt in the UX round and verified launching live. Phase 9 owner-gated.**

The UX overhaul (branch `feat/ui-overhaul`) fixed two launch-blocking bugs found in
review — the missing Tauri 2 capabilities file (dialogs/events/opener were ACL-denied)
and drag-drop written against the Tauri 1 API (drops did nothing) — and rebuilt the app
around a pre-sync sources view: scan-before-sync device summary, per-file device
re-assign and reference choice, persisted settings, first-run onboarding, dark suite
theme (D-026), localized errors with cancel-as-notice (D-030), and cache
inspection/clearing (D-013 follow-through). All three §9 advanced gaps are closed:
device re-assignment (D-028), segment count (D-028), and re-sync after re-grouping
(D-027). `npm run tauri dev` compiles and the app launches and runs.

Repo: <https://github.com/SundaySuite-app/sundaysync> (public).

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Skeleton | ✅ Accepted | Workspace, CI, lint gate, stub `sync()`, CLI. All four CI jobs green on run 30277454384. |
| 1 — Probe & inventory | ✅ Accepted | ffprobe integration, device grouping, `scan` command. 50 tests. All four CI jobs green; PR #1 merged. |
| 2 — Extraction & cache | ✅ Accepted | ffmpeg → 12 kHz mono f32 PCM, blake3-keyed cache, parallel decode. 71 tests. PR #2 merged. |
| 3 — Offset engine | ✅ Accepted | `fixturegen` + GCC-PHAT. `MIN_PSR` calibrated to 15.0. 106 tests. PR #3 merged. **Read D-016 before Phase 4.** |
| 4 — Placement & drift | ✅ Accepted | §4.4 placement, §4.6 drift, full `sync()` pipeline, proptest invariants. 136 tests. |
| 5 — FCPXML export | ✅ Accepted | §6 exporter, golden tests, **verified in DaVinci Resolve Studio 21.0.3.7** — frame-accurate, correct track layout, media relinked. |
| 6 — CLI complete + real corpus | 🔶 CLI done, corpus pending | `sync`/`scan`/`bench` all implemented and working. **Corpus onboarding needs Richard's footage** — the harness is ready and waiting. |
| 7 — Tauri app, simple mode | ✅ Built + launches | UX round: sources view before sync, real clip widths, phase machine, dark theme. Verified running via `tauri dev`. |
| 8 — Advanced mode + diagnostics | ✅ Built + launches | Settings dialog: threshold, segment count, cache dir/size/clear, reference from sources view, device re-assign, diagnostics, onboarding replay. Settings persist (D-029). |
| 9 — Release | ⬜ Not started | Needs signing certs, updater keys and a tag workflow — all owner-gated. |

## What Phase 0 actually delivered

- **Workspace** per §3: `crates/core` (engine, GUI-free), `crates/cli` (binary
  `sundaysync`), `crates/fixturegen` (stub until Phase 3). `app/` is a placeholder.
- **The `SyncResult` contract (§5) in full** — `schema`, `parameters`, `reference`,
  `devices`, `placements`, `unsynced`, `sequence`, `warnings`, with typed
  `UnsyncedReason` and `Warning` enums whose serde spellings match the plan verbatim.
  The shape is stable; the pipeline behind it is not implemented.
- **Determinism scaffolding:** `sort_deterministically()` (§5 orderings) and a
  byte-equality test that is trivial today but wired up so §13.4 cannot be forgotten
  when Phase 3 makes it load-bearing.
- **The §7.3 accounting invariant** as a real, testable method (`accounts_for`), ready
  for the Phase 4 property tests.
- **The §7.1 lint gate, verified to fire** — not merely configured. See DECISIONS.md D-002.
- **Exact rational frame rates** (D-003), so §6's FCPXML frame durations can be exact.
- **CI** — fmt, clippy `-D warnings`, tests, and the §11 acceptance command, plus a
  `cargo audit` job. ffmpeg is installed on the runner already so Phase 1 needs no CI
  change.

## What Phase 1 delivered

- **Process-isolated ffprobe** (`sidecar.rs`) with the §4.1 30 s timeout. Output pipes
  are drained on dedicated threads — polling `try_wait` while leaving them unread
  deadlocks the moment a child outruns the OS pipe buffer, which a malformed file is
  exactly what triggers. Regression-tested with a 400 KB writer and a hung child.
  **CI caught a real bug here** (D-010): a killed child does not close pipes its own
  children inherited, so joining the readers on the timeout path could block
  indefinitely — a 150 ms timeout returned after 30 s. Invisible on macOS, which execs
  where Ubuntu's dash forks.
- **Probe parsing** (`probe.rs`) — every ffprobe field read leniently, validated after.
  Handles cover art in MP3s (a "video stream" that is really a JPEG), degenerate `0/0`
  frame rates, multiple audio streams, and vendor make/model stutter.
- **§4.5 device grouping** (`device.rs`) — folder → metadata → filename → signature,
  per file (D-008). Pure function, no filesystem access.
- **`scan` orchestration** (`scan.rs`) — recursive walk with a depth cap, dotfile
  skipping (D-009), dedup, and correct bucketing into syncable vs. `no_audio` /
  `decode_error`.
- **`sundaysync scan`** prints the manifest as JSON.

Verified end to end on a synthetic mixed shoot (2 camera folders + a recorder folder,
plus a zero-byte file, a corrupt file, a video-only file and macOS dotfile litter):
3 devices grouped by subfolder with correct kinds, 4 syncable files, 3 correctly-reasoned
unsynced entries, dotfiles ignored.

## What Phase 2 delivered

- **`cache.rs`** — BLAKE3 key over (canonical path, size, mtime, `ANALYSIS_RATE`), so
  retuning the rate invalidates every entry rather than silently serving audio at the
  wrong one. Zero-length entries count as absent: a truncated file left by a force-killed
  older build must never be served as silent audio.
- **`extract.rs`** — `ffmpeg -map 0:a:0 -ac 1 -ar 12000 -f f32le`, decode-to-scratch then
  `rename`, bounded parallelism, and instrumentation (`decode_count`, `peak_concurrency`)
  that lets the §11 criteria actually be *asserted* rather than assumed.
- **Cancellation pushed into `sidecar::run`** (D-012) — required once decodes got long
  enough that a between-files check could no longer honour §7.4's 2 s budget.

Measured on 180 minutes of audio across 5 files: cold 7.1 s at peak concurrency 4, warm
sub-millisecond with zero ffmpeg processes, 46.9 KB per audio-second. See D-013 — the
per-second figure matches the plan, but cache *growth over time* is unmanaged and needs a
product decision before Phase 7's UI copy claims it is negligible.

## What Phase 3 delivered

- **`fixturegen`** (§8.1) — deterministic synthetic shoots from a seed: hand-rolled
  xoshiro256** PRNG (no `rand`, whose stream may change across versions), broadband
  speech/music/percussive master audio, and per-device gain, spectral tilt, reverb, noise
  at a set SNR, and clock drift. Emits WAV/FLAC/AAC/MP4 plus `truth.json`. `quick` and
  `full` tiers per §8.1.
- **`correlate.rs`** (§4.3) — GCC-PHAT via `rustfft`, using **overlap-save** so memory
  depends on segment length, never shoot length. A single transform over a 3-hour
  reference would be a quarter-billion complex bins, against §7.7's 4 GB ceiling for the
  whole run. PHAT survives the split: normalising each spectrum to unit magnitude keeps
  blocks directly comparable. Segmentation, median offset, MAD consistency, PSR and
  parabolic sub-sample interpolation all per §4.3.
- **The accuracy harness** (`tests/accuracy.rs`) — generates fixtures, runs the real
  extraction and correlation path, and asserts the §8.2 gates.

### Measured

| | |
| --- | --- |
| Correlator error on non-drifting clips | **−0.01 ms** |
| AAC / MP4 systematic bias | **≤ 0.01 ms** (D-004 not reproduced) |
| Real-match PSR range | 30.9 – 567 |
| Unrelated-audio PSR range | 5.2 – 9.2 |
| `quick` suite runtime | 9.8 s |

Two findings worth reading in full: **D-014** (the fixture reverb produced a fake −5 ms
per-codec bias that mimicked D-004 exactly) and **D-016** (uncorrected drift will exceed
the §8.2 gate on long clips — needs an owner decision).

## Verification

Local (macOS, 2026-07-27) and on CI:

```
cargo fmt --all --check                               ✅
cargo clippy --workspace --all-targets -- -D warnings ✅
cargo test --workspace                                ✅ 136 passed
cargo run -q -p sundaysync-cli -- sync --help         ✅
cargo run -q -p sundaysync-cli -- scan <shoot>        ✅
```

Run the suite with `SUNDAYSYNC_REQUIRE_FFMPEG=1` to turn the "ffprobe unavailable" skip
into a failure — that is how CI runs it on ubuntu (D-005).

All four CI jobs green on both phases — ubuntu (full gate), macOS, Windows, and
`cargo audit`. Phase 0: run 30277454384. Phase 1: PR #1, merged as `5b0bdf9`.

## Open items carried into later phases

- **⚠️ DECISIONS.md D-016 — needs Richard's decision.** Uncorrected drift consumes the
  whole ±10 ms budget on clips over ~8 minutes at 40 ppm. A 90-minute continuous recording
  would land ~108 ms out. §4.6 defers correction to v2; §8.2 demands ±10 ms. One of the
  three has to give, and picking is a plan change, not an implementation detail.
- **`MIN_PSR = 15.0` is calibrated on synthetic material only** (D-015) and must be
  re-validated against the real corpus in Phase 6.
- **DECISIONS.md D-004 is unfalsified but not reproduced** — measured per-codec bias is
  ≤ 0.01 ms through the ffmpeg decode path. Keep the multi-codec fixture coverage; the
  cost is nil and it is the only thing that would catch a regression.
- **Correlation cost scales with reference length.** ~10 blocks for a 10-minute reference;
  a 3-hour service would be ~160 per segment. §10's 6-minute target assumes decode-bound,
  which stops being true at that scale. The known fix is a decimated coarse search
  followed by a narrow refine; deferred until the Phase 6 corpus shows whether it matters.
- **Probing is still sequential.** The parallel pool now exists in `extract.rs`; moving
  probing onto it is a small, worthwhile follow-up (a shoot with several hung files
  currently costs 30 s each, serially).
- **The cache has no eviction policy** (D-013) — grows ~169 MB per audio-hour, forever.
  A product decision for Phase 8, and it shapes Phase 7's tooltip copy.
- **Memory-mapping the analysis PCM is deferred to Phase 3** (D-011), where the FFT
  access pattern can say whether §7.7 actually needs it. Adopting it means relaxing
  `unsafe_code` from `forbid` to `deny`.
- **GoPro `.LRV` proxies** would appear as a phantom device — see D-009. Deliberately
  left for the Phase 6 corpus to judge on real footage.
- **DECISIONS.md D-002** — `crates/core/Cargo.toml` restates the workspace lints because
  cargo forbids mixing inheritance with additions. Keep them in sync by hand.
