# Status

Per [`PLAN.md`](PLAN.md) §13.5, this file always reflects reality. Updated at every phase end.

**Current phase: 0 — Skeleton. Complete, pending CI verification on GitHub.**

| Phase | State | Notes |
| --- | --- | --- |
| 0 — Skeleton | ✅ Complete (locally green) | Workspace, CI, lint gate, stub `sync()`, CLI. Not yet pushed, so CI is unverified on a real runner. |
| 1 — Probe & inventory | ⬜ Not started | Next. |
| 2 — Extraction & cache | ⬜ Not started | |
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

## Local verification (macOS, 2026-07-27)

```
cargo fmt --all --check                              ✅
cargo clippy --workspace --all-targets -- -D warnings ✅
cargo test --workspace                                ✅ 18 passed
cargo run -q -p sundaysync-cli -- sync --help         ✅
```

The stub emits well-formed schema-v1 JSON end to end.

## Open items

- **CI is unverified on a real runner** — Phase 0's acceptance criterion is "CI green",
  and that cannot be claimed until this is pushed to GitHub. No remote exists yet.
- **`DEFAULT_MIN_PSR = 5.0` is provisional**, taken from the plan's worked example. §4.3
  requires it to be calibrated against the synthetic suite in Phase 3.
- **DECISIONS.md D-004** — codec decoder delay threatens the ±10 ms gate. Blocking input
  to the Phase 3 fixture design.
