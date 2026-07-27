# Status

Per [`PLAN.md`](PLAN.md) §13.5, this file always reflects reality. Updated at every phase end.

**Current phase: 1 — Probe & inventory. ✅ ACCEPTED — CI green, PR #1 merged.**

Repo: <https://github.com/SundaySuite-app/sundaysync> (public).

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Skeleton | ✅ Accepted | Workspace, CI, lint gate, stub `sync()`, CLI. All four CI jobs green on run 30277454384. |
| 1 — Probe & inventory | ✅ Accepted | ffprobe integration, device grouping, `scan` command. 50 tests. All four CI jobs green; PR #1 merged. |
| 2 — Extraction & cache | ⬜ Not started | Next. Builds the `min(4, cores)` parallel infrastructure; probing should move onto it. |
| 3 — Offset engine | ⬜ Not started | Build `fixturegen` first. **Read DECISIONS.md D-004 before starting.** |
| 4 — Placement & drift | ⬜ Not started | |
| 5 — FCPXML export | ⬜ Not started | |
| 6 — CLI complete + real corpus | ⬜ Not started | Needs corpus material from Richard. |
| 7 — Tauri app, simple mode | ⬜ Not started | `app/` is an empty placeholder until here. |
| 8 — Advanced mode + diagnostics | ⬜ Not started | |
| 9 — Release | ⬜ Not started | |

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

## Verification

Local (macOS, 2026-07-27) and on CI:

```
cargo fmt --all --check                               ✅
cargo clippy --workspace --all-targets -- -D warnings ✅
cargo test --workspace                                ✅ 50 passed
cargo run -q -p sundaysync-cli -- sync --help         ✅
cargo run -q -p sundaysync-cli -- scan <shoot>        ✅
```

Run the suite with `SUNDAYSYNC_REQUIRE_FFMPEG=1` to turn the "ffprobe unavailable" skip
into a failure — that is how CI runs it on ubuntu (D-005).

All four CI jobs green on both phases — ubuntu (full gate), macOS, Windows, and
`cargo audit`. Phase 0: run 30277454384. Phase 1: PR #1, merged as `5b0bdf9`.

## Open items carried into later phases

- **`DEFAULT_MIN_PSR = 5.0` is provisional**, taken from the plan's worked example, not
  measured. §4.3 requires calibration against the synthetic suite in Phase 3.
- **DECISIONS.md D-004** — per-codec decoder delay threatens the ±10 ms gate in §8.2.
  Blocking input to the Phase 3 fixture design; fixtures must span multiple codecs.
- **Probing is sequential.** Fine at ~30 ms per file, but a shoot with many hung files
  could spend 30 s each. Phase 2 builds the parallel-decode infrastructure (§4.2,
  `min(4, cores)`); probing should reuse it then.
- **GoPro `.LRV` proxies** would appear as a phantom device — see D-009. Deliberately
  left for the Phase 6 corpus to judge on real footage.
- **DECISIONS.md D-002** — `crates/core/Cargo.toml` restates the workspace lints because
  cargo forbids mixing inheritance with additions. Keep them in sync by hand.
